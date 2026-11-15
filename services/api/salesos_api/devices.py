import asyncio
import base64
import binascii
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from fastapi import HTTPException
from .repository import Repository, now
from .security import digest, expires, is_expired, relative_path
from .files import Files


class Devices:
    def __init__(self,repo: Repository,files: Files):
        self.repo,self.files=repo,files

    async def enrollment(self,owner):
        code=secrets.token_hex(5).upper()
        expiry=expires(10)
        await self.repo.insert('device_enrollments',digest(code),owner,{'expires_at':expiry,'consumed':False})
        return {'code':code,'expires_at':expiry}

    async def enroll(self,code,name):
        row=await self.repo.get('device_enrollments',digest(code.strip().upper()))
        if not row or row['data'].get('consumed') or is_expired(row['data']['expires_at']):
            raise HTTPException(400,'연결 코드가 만료되었거나 이미 사용되었습니다.')
        member=await self.repo.member(row['owner_id'])
        if not member or not member.get('active'):
            raise HTTPException(403,'활성 직원의 연결 코드가 아닙니다.')
        if not await self.repo.cas(row,{**row['data'],'consumed':True}):
            raise HTTPException(409,'이미 사용된 연결 코드입니다.')
        id=str(uuid4());token='sos_device_'+secrets.token_urlsafe(40)
        await self.repo.insert('devices',id,row['owner_id'],{'name':name[:80], 'revoked':False,'last_seen_at':now(),'token_hash':digest(token)})
        await self.repo.insert('device_tokens',digest(token),row['owner_id'],{'device_id':id,'revoked':False})
        return {'device_id':id,'device_token':token,'max_file_bytes':self.files.settings.device_file_limit}

    async def list(self,owner):
        result=[]
        roots, devices = await asyncio.gather(self.repo.list('roots', owner), self.repo.list('devices', owner))
        for row in devices:
            data=row['data']
            if data.get('revoked'):continue
            seen=data.get('last_seen_at')
            online=seen and datetime.fromisoformat(seen)>datetime.now(timezone.utc)-timedelta(seconds=90)
            result.append({'id':row['id'],'name':data['name'],'status':'online' if online else 'offline','last_seen_at':seen,
                'roots':[{'id':r['data']['id'],'name':r['data']['name'],'enabled':r['data']['enabled']} for r in roots if r['data']['device_id']==row['id'] and r['data'].get('enabled')]})
        return result

    async def heartbeat(self,device):
        latest=await self.repo.get('devices',device['id'],device['owner_id'])
        if not latest or latest['data'].get('revoked'):
            raise HTTPException(401,'해제된 PC입니다.')
        await self.repo.cas(latest,{**latest['data'],'last_seen_at':now()})
        return {'ok':True,'server_time':now(),'max_file_bytes':self.files.settings.device_file_limit}

    async def roots(self,device,roots):
        seen=set()
        if len(roots)>20:raise HTTPException(400,'허용 폴더는 최대 20개입니다.')
        for root in roots:
            id=root['id']
            if not id or len(id)>100 or any(c in id for c in '/\\:') or id in seen:
                raise HTTPException(400,'폴더 식별자가 올바르지 않습니다.')
            seen.add(id)
            key=f"{device['id']}:{id}"
            previous=await self.repo.get('roots',key,device['owner_id'])
            data={'id':id,'name':root['name'][:100],'device_id':device['id'],'enabled':bool(root.get('enabled',True)),
                'version':(previous['data'].get('version',0) if previous else 0)+1}
            if previous and all(previous['data'].get(k)==data[k] for k in ('name','enabled')):
                continue
            await self.repo.save('roots',key,device['owner_id'],data)
        for root in await self.repo.list('roots',device['owner_id']):
            if root['data']['device_id']==device['id'] and root['data']['id'] not in seen and root['data'].get('enabled'):
                await self.repo.cas(root,{**root['data'],'enabled':False,'version':root['data'].get('version',0)+1})
        for job in await self.repo.list('jobs',device['owner_id']):
            if job['data'].get('device_id')==device['id'] and job['data'].get('status') in ('pending','waiting_device','processing'):
                root=await self.repo.get('roots',f"{device['id']}:{job['data']['root_id']}",device['owner_id'])
                if not root or not root['data'].get('enabled') or root['data'].get('version')!=job['data']['root_version']:
                    await self.repo.cas(job,{**job['data'],'status':'cancelled','error':'폴더 연결이 변경되었습니다.','updated_at':now()})
        return {'ok':True}

    async def disconnect(self,device):
        await self.repo.save('devices',device['id'],device['owner_id'],{**device['data'],'revoked':True})
        token=await self.repo.get('device_tokens',device['data']['token_hash'],device['owner_id'])
        if token:await self.repo.cas(token,{**token['data'],'revoked':True})
        await self.roots(device,[])
        return {'ok':True}

    async def create_job(self,owner,device_id,root_id,operation,*,path=None,query=None,thread_id=None):
        connection = await self.repo.get('connections', f'{owner}:local_files', owner)
        if connection and not connection['data'].get('enabled', True):
            raise HTTPException(409, '내 PC 연결을 사용하지 않도록 설정되어 있습니다.')
        if thread_id and not await self.repo.get('threads', thread_id, owner):
            raise HTTPException(404, '접근 가능한 대화가 아닙니다.')
        device=await self.repo.get('devices',device_id,owner)
        root=await self.repo.get('roots',f'{device_id}:{root_id}',owner)
        if not device or device['data'].get('revoked') or not root or not root['data'].get('enabled'):
            raise HTTPException(404,'접근 가능한 PC 폴더가 아닙니다.')
        if operation not in ('list','search','read'):raise HTTPException(400,'지원하지 않는 PC 요청입니다.')
        if operation=='read':path=relative_path(path or '')
        id=str(uuid4())
        online=datetime.fromisoformat(device['data']['last_seen_at'])>datetime.now(timezone.utc)-timedelta(seconds=90)
        data={'title':f"로컬 파일 {'읽기' if operation=='read' else '검색'}",'kind':'local_file','operation':operation,
            'device_id':device_id,'root_id':root_id,'root_version':root['data']['version'],'path':path,'query':query,
            'thread_id':thread_id,'limit':100,'status':'pending' if online else 'waiting_device','created_at':now(),'updated_at':now(),'expires_at':expires(60),'attempts':0}
        await self.repo.insert('jobs',id,owner,data)
        return {'id':id,**data}

    async def claim(self,device):
        await self.heartbeat(device)
        jobs=await self.repo.list('jobs',device['owner_id'])
        for row in reversed(jobs):
            job=row['data']
            if job.get('kind')!='local_file' or job.get('device_id')!=device['id']:continue
            status=job['status']
            if status=='processing' and not is_expired(job.get('lease_until','')):continue
            if status not in ('pending','waiting_device','processing'):continue
            if is_expired(job['expires_at']):
                await self.repo.cas(row,{**job,'status':'expired','updated_at':now()});continue
            root=await self.repo.get('roots',f"{device['id']}:{job['root_id']}",device['owner_id'])
            if not root or not root['data'].get('enabled') or root['data']['version']!=job['root_version']:
                await self.repo.cas(row,{**job,'status':'cancelled','updated_at':now()});continue
            updated=await self.repo.cas(row,{**job,'status':'processing','attempts':job.get('attempts',0)+1,'lease_until':expires(2),'updated_at':now()})
            if updated:
                return {'max_file_bytes':self.files.settings.device_file_limit,'job':{'id':row['id'],'max_file_bytes':self.files.settings.device_file_limit,**{k:job.get(k) for k in ('operation','root_id','path','query','limit')}}}
        return {'job':None,'max_file_bytes':self.files.settings.device_file_limit}

    async def result(self,device,job_id,payload):
        row=await self.repo.get('jobs',job_id,device['owner_id'])
        if not row or row['data'].get('device_id')!=device['id'] or row['data'].get('kind')!='local_file':
            raise HTTPException(404,'이 PC의 작업이 아닙니다.')
        job=row['data']
        if job['status'] in ('succeeded','failed'):
            return {'ok':True,'duplicate':True,'status':job['status']}
        if job['status']!='processing':raise HTTPException(409,'실행 중인 작업이 아닙니다.')
        root=await self.repo.get('roots',f"{device['id']}:{job['root_id']}",device['owner_id'])
        if not root or not root['data'].get('enabled') or root['data']['version']!=job['root_version']:
            raise HTTPException(409,'폴더 연결이 변경되어 결과를 받지 않았습니다.')
        if not payload.get('ok'):
            # Do not persist arbitrary client exceptions containing local paths.
            message = 'PC에서 파일을 읽지 못했습니다. 파일 상태와 폴더 접근 권한을 확인해 주세요.'
            if str(payload.get('error', '')).startswith('FILE_TOO_LARGE:'):
                message = f'파일이 이 서버의 PC 읽기 한도({self.files.settings.device_file_limit / (1024 * 1024):g}MB)를 초과했습니다.'
            result={'error':message};status='failed'
        elif job['operation'] in ('list','search'):
            files=payload.get('files') or []
            if len(files)>500:raise HTTPException(413,'파일 목록 제한을 초과했습니다.')
            clean=[]
            for item in files:
                clean.append({'name':str(item.get('name',''))[:180],'relative_path':relative_path(item['relative_path']),
                    'is_directory':bool(item.get('is_directory')),'size':item.get('size'),'mtime':item.get('mtime')})
            result={'files':clean,'truncated':bool(payload.get('truncated'))};status='succeeded'
        else:
            path=relative_path(payload.get('relative_path',''))
            if path!=job['path']:raise HTTPException(400,'요청한 파일과 결과 파일이 다릅니다.')
            encoded=payload.get('content_base64','')
            maximum = self.files.settings.device_file_limit
            if not isinstance(encoded, str):raise HTTPException(400,'파일 전송 형식이 올바르지 않습니다.')
            if len(encoded)>4*((maximum+2)//3):raise HTTPException(413,'PC 파일 전송 크기 제한을 초과했습니다.')
            try:content=base64.b64decode(encoded,validate=True)
            except (ValueError,binascii.Error):raise HTTPException(400,'파일 전송 형식이 올바르지 않습니다.') from None
            if len(content)>maximum:raise HTTPException(413,'PC 파일 전송 크기 제한을 초과했습니다.')
            if payload.get('sha256') and hashlib.sha256(content).hexdigest()!=payload['sha256']:
                raise HTTPException(400,'파일 해시가 일치하지 않습니다.')
            record=await self.files.create(device['owner_id'],payload.get('filename') or path,content,source={
                'device_id':device['id'],'root_id':job['root_id'],'root_version':job['root_version'],'relative_path':path,'mtime':payload.get('mtime')})
            result={'file_id':record['id'],'filename':record['filename'],'text':record['text'],'truncated':record['truncated'],
                'read_at':record['read_at'],'size':record['size'],'sha256':record['sha256']};status='succeeded'
        latest=await self.repo.get('jobs',job_id,device['owner_id'])
        if latest['data']['status']!='processing':raise HTTPException(409,'작업 상태가 변경되었습니다.')
        changed=await self.repo.cas(latest,{**latest['data'],'status':status,'result':result,'error':result.get('error'),'updated_at':now()})
        if not changed:raise HTTPException(409,'작업 상태가 변경되었습니다.')
        return {'ok':True,'status':status}
