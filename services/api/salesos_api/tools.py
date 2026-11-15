import asyncio
import base64
import json
import hashlib
import math
import httpx
import re
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid5
from fastapi import HTTPException
from .repository import Repository, now
from .providers import Providers
from .devices import Devices
from .files import Files


def function(name,description,properties,required=None):
    return {'type':'function','name':name,'description':description,'parameters':{
        'type':'object','properties':properties,'required':required or list(properties),'additionalProperties':False},'strict':False}

STRING={'type':'string'}
TOOLS=[
    function('connection_status','현재 사용자의 서비스 연결 상태를 확인합니다.',{}),
    function('search_threads','현재 직원의 SALES-OS 대화를 제목으로 찾습니다.',{'query':STRING}),
    function('read_thread','현재 직원의 SALES-OS 대화 내용을 읽습니다.',{'thread_id':STRING}),
    function('search_gmail','본인 Gmail 메일 검색. query는 Gmail 검색 문법입니다.',{'query':STRING}),
    function('read_gmail','검색으로 얻은 본인 메일 ID의 본문을 읽습니다.',{'message_id':STRING}),
    function('search_drive','본인 Drive 파일명으로 검색합니다.',{'query':STRING}),
    function('read_drive_file','본인 접근 가능한 텍스트/Google 문서/시트 파일을 읽습니다.',{'file_id':STRING}),
    function('read_sheet','본인 Google Sheet 지정 범위의 데이터를 읽습니다.',{'spreadsheet_id':STRING,'range':STRING}),
    function('update_sheet_range','사용자가 명시적으로 요청한 경우만 Google Sheet의 정확한 범위를 덮어씁니다. 먼저 기존 범위를 읽고 변경 대상을 확인하세요. range는 시트명이 포함된 유한 A1 범위(예: 업무!A2:C3), values는 범위와 크기가 같은 행 배열입니다. 값은 RAW로 저장해 수식을 실행하지 않습니다. 최대 1000행/100열/10000셀. 결과가 불확실하면 새 쓰기를 반복하지 말고 범위를 조회하세요.',
        {'spreadsheet_id':STRING,'range':STRING,'values':{'type':'array','items':{'type':'array','items':{'type':['string','number','boolean']}}}}),
    function('list_chat_spaces','본인 Google Chat 방 목록을 표시합니다. 읽기 허용 여부를 함께 반환합니다.',{}),
    function('read_chat_messages','사용자가 허용 목록에 등록한 Google Chat 방의 메시지를 읽습니다.',{'space':STRING,'thread':STRING},['space']),
    function('list_calendar_events','연결된 본인 Google Calendar 일정 조회. time_min/time_max는 시간대가 포함된 ISO 8601.',{'time_min':STRING,'time_max':STRING}),
    function('create_calendar_event','사용자가 명시적으로 일정 등록을 요청한 경우만 본인 기본 Google Calendar에 단일 일정을 만듭니다. 제목·시작·종료를 임의로 추측하지 마세요. start_at/end_at은 시간대가 포함된 ISO 8601입니다. 참석자 초대·반복 일정은 지원하지 않습니다. 결과가 불확실하면 새 생성 호출 대신 일정을 조회하세요.',
        {'title':STRING,'start_at':STRING,'end_at':STRING,'description':STRING,'location':STRING},['title','start_at','end_at']),
    function('search_notion','연결된 Notion 페이지 제목을 검색합니다.',{'query':STRING}),
    function('read_notion_page','접근 가능한 Notion 페이지의 첫 100개 블록을 읽습니다.',{'page_id':STRING}),
    function('list_devices','현재 직원이 등록한 PC와 읽기 허용 폴더 목록을 조회합니다.',{}),
    function('search_local_files','현재 직원 PC의 허용 폴더에서 파일명으로 검색합니다. PC가 오프라인이면 대기 작업을 만듭니다.',{'device_id':STRING,'root_id':STRING,'query':STRING}),
    function('read_local_file','허용 폴더의 상대 경로 파일을 읽습니다. 절대 경로, 상위 경로, 수정/실행은 지원하지 않습니다.',{'device_id':STRING,'root_id':STRING,'path':STRING}),
    function('get_job_status','현재 직원의 작업 상태와 실제 결과를 조회합니다.',{'job_id':STRING}),
    function('create_task','사용자가 명시적으로 요청한 할 일을 등록합니다. 요약 요청만으로 실행하지 않습니다.',{'title':STRING,'description':STRING,'due_at':STRING},['title']),
    function('save_contact','사용자가 명시적으로 요청한 연락처를 DB에 저장합니다. Notion 부모 페이지가 설정되어 있으면 반영 작업도 생성합니다.',{'name':STRING,'company':STRING,'email':STRING,'phone':STRING,'memo':STRING},['name']),
]

# Keep the same operation definitions for ChatKit and the OpenAPI tool adapter.
# Resolve an omitted ID only when precisely one usable account exists.
GOOGLE_TOOLS = {
    'search_gmail': 'gmail', 'read_gmail': 'gmail',
    'search_drive': 'google_drive', 'read_drive_file': 'google_drive',
    'read_sheet': 'google_sheets', 'update_sheet_range': 'google_sheets',
    'list_chat_spaces': 'google_chat', 'read_chat_messages': 'google_chat',
    'list_calendar_events': 'google_calendar', 'create_calendar_event': 'google_calendar',
}
for tool in TOOLS:
    if tool['name'] in GOOGLE_TOOLS:
        tool['parameters']['properties']['connection_id'] = {
            'type': 'string', 'description': 'connection_status에서 확인한 본인 Google 연결 계정 ID. 여러 계정이면 반드시 지정합니다.'}


def safe_google_id(value):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',value):
        raise HTTPException(400,'자료 ID가 올바르지 않습니다.')
    return value


def checked_text(value, field, maximum, *, required=False):
    if not isinstance(value, str) or len(value) > maximum or '\x00' in value or (required and not value.strip()):
        raise HTTPException(400, f'{field} 입력을 확인해 주세요.')
    return value


def checked_sheet_update(args):
    spreadsheet_id = checked_text(args.get('spreadsheet_id'), '스프레드시트 ID', 200, required=True)
    safe_google_id(spreadsheet_id)
    target = checked_text(args.get('range'), '시트 범위', 250, required=True)
    # Require a named sheet and a bounded rectangle; no named ranges or whole rows/columns.
    match = re.fullmatch(r"('(?:[^']|'')+'|[^'!:\[\]/\\?*]+)!([A-Za-z]{1,3})([1-9][0-9]{0,6})(?::([A-Za-z]{1,3})([1-9][0-9]{0,6}))?", target)
    if not match or any(ord(char) < 32 for char in target):
        raise HTTPException(400, '시트명과 시작·끝 셀이 명확한 A1 범위가 필요합니다. 예: 업무!A2:C3')
    sheet, first_column, first_row, last_column, last_row = match.groups()
    if len(sheet.strip("'").replace("''", "'")) > 100:
        raise HTTPException(400, '시트 이름이 너무 깁니다.')
    def column(value):
        number = 0
        for char in value.upper(): number = number * 26 + ord(char) - 64
        return number
    first_row, last_row = int(first_row), int(last_row or first_row)
    height, width = last_row - first_row + 1, column(last_column or first_column) - column(first_column) + 1
    if not (1 <= height <= 1000 and 1 <= width <= 100 and height * width <= 10000 and last_row <= 1000000):
        raise HTTPException(400, '한 번에 최대 1000행·100열·10000셀, 100만 번째 행 이내의 범위를 지정해 주세요.')
    values = args.get('values')
    if not isinstance(values, list) or len(values) != height or any(not isinstance(row, list) or len(row) != width for row in values):
        raise HTTPException(400, 'values 행·열 수가 지정한 범위와 같아야 합니다.')
    for row in values:
        for value in row:
            if type(value) not in (str, int, float, bool) or (isinstance(value, str) and (len(value) > 5000 or '\x00' in value)):
                raise HTTPException(400, '셀에는 5000자 이하 문자열·숫자·불리언만 저장할 수 있습니다.')
            if isinstance(value, float) and not math.isfinite(value):
                raise HTTPException(400, '유한한 숫자만 저장할 수 있습니다.')
    if len(json.dumps(values, ensure_ascii=False).encode()) > 200000:
        raise HTTPException(400, '저장할 셀 데이터가 너무 큽니다.')
    return {'spreadsheet_id': spreadsheet_id, 'range': target, 'values': values}


def checked_event_time(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})', value):
        raise HTTPException(400, '시작·종료에 시간대가 포함된 날짜가 필요합니다.')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise HTTPException(400, '시작·종료 날짜가 올바르지 않습니다.') from None
    return result


def checked_calendar_event(args):
    title = checked_text(args.get('title'), '일정 제목', 200, required=True)
    start, end = checked_event_time(args.get('start_at')), checked_event_time(args.get('end_at'))
    if not 0 < (end - start).total_seconds() <= 366 * 86400:
        raise HTTPException(400, '종료는 시작 이후여야 하며 단일 일정은 366일 이내로 지정해 주세요.')
    return {'summary': title, 'start': {'dateTime': start.isoformat()}, 'end': {'dateTime': end.isoformat()},
            'description': checked_text(args.get('description', ''), '일정 설명', 10000),
            'location': checked_text(args.get('location', ''), '일정 장소', 500)}


def same_sheet_values(actual, expected):
    if not isinstance(actual, list) or len(actual) > len(expected): return False
    for index, wanted in enumerate(expected):
        row = actual[index] if index < len(actual) else []
        if not isinstance(row, list) or len(row) > len(wanted): return False
        for offset, value in enumerate(wanted):
            got = row[offset] if offset < len(row) else ''
            if isinstance(got, bool) != isinstance(value, bool) or got != value: return False
    return True


def same_calendar_event(actual, expected):
    if not isinstance(actual, dict) or actual.get('status') == 'cancelled': return False
    if any(actual.get(key, '') != expected.get(key, '') for key in ('id', 'summary', 'description', 'location')): return False
    if actual.get('extendedProperties', {}).get('private', {}) != expected['extendedProperties']['private']: return False
    try:
        return all(checked_event_time(actual[field]['dateTime']) == checked_event_time(expected[field]['dateTime']) for field in ('start', 'end'))
    except (HTTPException, KeyError, TypeError):
        return False


class BusinessTools:
    def __init__(self,repo:Repository,providers:Providers,devices:Devices,files:Files):
        self.repo,self.providers,self.devices,self.files=repo,providers,devices,files

    async def call(self,name,args,owner,thread_id,call_id):
        try:
            source = None
            if name in GOOGLE_TOOLS:
                connection = await self.providers.connection(owner, GOOGLE_TOOLS[name], args.get('connection_id'))
                source = {'connection_id': connection['data'].get('connection_id'),
                          'account': connection['data'].get('account')}
                args = {**args, 'connection_id': source['connection_id']}
            result = await self._call(name,args,owner,thread_id,call_id)
            return {**result, 'source': source} if source is not None else result
        except HTTPException as exc:
            return {'error':exc.detail,'status':exc.status_code}
        except Exception:
            return {'error':'도구 실행을 완료하지 못했습니다. 연결 상태와 입력을 확인해 주세요.','status':500}

    async def _call(self,name,a,owner,thread_id,call_id):
        if name in ('update_sheet_range', 'create_calendar_event'):
            return await self.write_google(name, a, owner, thread_id, call_id)
        if name=='connection_status':return {'items':await self.providers.connections(owner)}
        if name=='search_threads':
            q=a['query'].lower()
            return {'items':[{'id':r['id'],'title':r['data'].get('title'),'created_at':r['data'].get('created_at')} for r in await self.repo.list('threads',owner) if q in (r['data'].get('title') or '').lower()][:30]}
        if name=='read_thread':
            thread=await self.repo.get('threads',a['thread_id'],owner)
            if not thread:raise HTTPException(404,'대화를 찾을 수 없습니다.')
            rows=[r['data'] for r in await self.repo.list('thread_items',owner) if r['data'].get('thread_id')==a['thread_id']]
            rows.sort(key=lambda x:(x.get('created_at',''),x['id']))
            return {'thread':thread['data'],'messages':[{'type':r['type'],'content':r.get('content')} for r in rows[-30:]],'partial':len(rows)>30}
        if name=='search_gmail':
            res=(await self.providers.google(owner,'gmail','GET','https://gmail.googleapis.com/gmail/v1/users/me/messages',connection_id=a.get('connection_id'),params={'q':a['query'][:500],'maxResults':15})).json()
            results=[]
            for message in res.get('messages',[]):
                detail=(await self.providers.google(owner,'gmail','GET','https://gmail.googleapis.com/gmail/v1/users/me/messages/'+message['id'],connection_id=a.get('connection_id'),params={'format':'metadata','metadataHeaders':['Subject','From','Date']})).json()
                headers={h['name'].lower():h['value'] for h in detail.get('payload',{}).get('headers',[])}
                results.append({'id':message['id'],'subject':headers.get('subject'),'from':headers.get('from'),'date':headers.get('date'),'snippet':detail.get('snippet'),'url':'https://mail.google.com/mail/u/0/#all/'+message['id']})
            return {'items':results,'partial':bool(res.get('nextPageToken'))}
        if name=='read_gmail':
            id=safe_google_id(a['message_id'])
            res=(await self.providers.google(owner,'gmail','GET','https://gmail.googleapis.com/gmail/v1/users/me/messages/'+id,connection_id=a.get('connection_id'),params={'format':'full'})).json()
            parts=[]
            def unpack(part):
                if part.get('mimeType')=='text/plain' and part.get('body',{}).get('data'):
                    data=part['body']['data'];parts.append(base64.urlsafe_b64decode(data+'='*((-len(data))%4)).decode('utf8',errors='replace'))
                for child in part.get('parts',[]):unpack(child)
            unpack(res.get('payload',{}))
            text='\n'.join(parts)
            return {'id':id,'text':text[:50000] or res.get('snippet',''),'partial':len(text)>50000 or not parts,'url':'https://mail.google.com/mail/u/0/#all/'+id}
        if name=='search_drive':
            q=a['query'][:200].replace('\\','\\\\').replace("'","\\'")
            data=(await self.providers.google(owner,'google_drive','GET','https://www.googleapis.com/drive/v3/files',connection_id=a.get('connection_id'),params={
                'q':f"trashed=false and name contains '{q}'",'pageSize':30,'fields':'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)'})).json()
            return {'items':data.get('files',[]),'partial':bool(data.get('nextPageToken'))}
        if name=='read_drive_file':
            id=safe_google_id(a['file_id']);url='https://www.googleapis.com/drive/v3/files/'+id
            meta=(await self.providers.google(owner,'google_drive','GET',url,connection_id=a.get('connection_id'),params={'fields':'id,name,mimeType,size,webViewLink'})).json()
            mime=meta['mimeType']
            exports={'application/vnd.google-apps.document':'text/plain','application/vnd.google-apps.spreadsheet':'text/csv'}
            if mime in exports:
                res=await self.providers.google(owner,'google_drive','GET',url+'/export',connection_id=a.get('connection_id'),params={'mimeType':exports[mime]})
            elif mime.startswith('text/'):
                if int(meta.get('size',0))>2*1024*1024:raise HTTPException(413,'파일이 너무 큽니다.')
                res=await self.providers.google(owner,'google_drive','GET',url,connection_id=a.get('connection_id'),params={'alt':'media'})
            else:raise HTTPException(415,'Drive에서는 현재 Google 문서·시트·텍스트를 읽을 수 있습니다.')
            if len(res.content)>2*1024*1024:raise HTTPException(413,'자료 크기가 제한을 초과합니다.')
            return {'name':meta['name'],'text':res.text[:50000],'partial':len(res.text)>50000 or mime=='application/vnd.google-apps.spreadsheet','url':meta.get('webViewLink')}
        if name=='read_sheet':
            id=safe_google_id(a['spreadsheet_id']);range=a['range'][:150]
            res=(await self.providers.google(owner,'google_sheets','GET',f'https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{quote(range,safe="")}',connection_id=a.get('connection_id'),params={'valueRenderOption':'FORMATTED_VALUE'})).json()
            rows=res.get('values',[])
            return {'range':res.get('range'),'values':[r[:100] for r in rows[:1000]],'partial':len(rows)>1000,'url':f'https://docs.google.com/spreadsheets/d/{id}'}
        if name=='list_chat_spaces':
            res=(await self.providers.google(owner,'google_chat','GET','https://chat.googleapis.com/v1/spaces',connection_id=a.get('connection_id'),params={'pageSize':100})).json()
            allowed=await self.repo.get('settings',f"{owner}:chat_spaces:{a['connection_id']}",owner)
            allowed=set(allowed['data'].get('spaces',[])) if allowed else set()
            return {'items':[{**s,'allowed':s['name'] in allowed} for s in res.get('spaces',[])],'partial':bool(res.get('nextPageToken'))}
        if name=='read_chat_messages':
            space=a['space'];allowed=await self.repo.get('settings',f"{owner}:chat_spaces:{a['connection_id']}",owner)
            if not re.fullmatch(r'spaces/[A-Za-z0-9_-]+',space) or not allowed or space not in allowed['data'].get('spaces',[]):
                raise HTTPException(403,'서비스 설정에서 읽기를 허용한 Google Chat 방만 조회할 수 있습니다.')
            params={'pageSize':100,'orderBy':'createTime desc'}
            thread=a.get('thread')
            if thread:
                if not re.fullmatch(re.escape(space)+r'/threads/[A-Za-z0-9_-]+',thread):raise HTTPException(400,'스레드가 올바르지 않습니다.')
                params['filter']=f'thread.name = "{thread}"'
            res=(await self.providers.google(owner,'google_chat','GET',f'https://chat.googleapis.com/v1/{space}/messages',connection_id=a.get('connection_id'),params=params)).json()
            return {'messages':[{'name':m['name'],'text':m.get('text',''),'createTime':m.get('createTime'),'thread':m.get('thread')} for m in res.get('messages',[])],'partial':bool(res.get('nextPageToken'))}
        if name=='list_calendar_events':
            for field in ('time_min','time_max'):
                try:dt=datetime.fromisoformat(a[field].replace('Z','+00:00'))
                except ValueError:raise HTTPException(400,'일정 조회 날짜가 올바르지 않습니다.') from None
                if dt.tzinfo is None:raise HTTPException(400,'시간대가 포함된 날짜가 필요합니다.')
            res=(await self.providers.google(owner,'google_calendar','GET','https://www.googleapis.com/calendar/v3/calendars/primary/events',connection_id=a.get('connection_id'),params={
                'timeMin':a['time_min'],'timeMax':a['time_max'],'singleEvents':'true','orderBy':'startTime','maxResults':100})).json()
            return {'items':res.get('items',[]),'partial':bool(res.get('nextPageToken'))}
        if name=='search_notion':
            res=await self.providers.notion(owner,'POST','search',json={'query':a['query'][:200],'page_size':30,'filter':{'value':'page','property':'object'}})
            return {'items':[{'id':p['id'],'url':p.get('url'),'properties':p.get('properties')} for p in res.get('results',[])],'partial':res.get('has_more',False)}
        if name=='read_notion_page':
            id=a['page_id']
            if not re.fullmatch(r'[0-9a-fA-F-]{32,36}',id):raise HTTPException(400,'페이지 ID가 올바르지 않습니다.')
            res=await self.providers.notion(owner,'GET',f'blocks/{id}/children',params={'page_size':100})
            items=[]
            for b in res.get('results',[]):
                text=''.join(t.get('plain_text',t.get('text',{}).get('content','')) for t in b.get(b['type'],{}).get('rich_text',[]))
                items.append({'id':b['id'],'type':b['type'],'text':text,'has_children':b.get('has_children')})
            return {'blocks':items,'partial':res.get('has_more',False) or any(b['has_children'] for b in items)}
        if name=='list_devices':return {'items':await self.devices.list(owner)}
        if name in ('search_local_files','read_local_file'):
            job=await self.devices.create_job(owner,a['device_id'],a['root_id'],'search' if name=='search_local_files' else 'read',
                query=a.get('query'),path=a.get('path'),thread_id=thread_id)
            if job['status']=='waiting_device':return job
            for _ in range(15):
                await asyncio.sleep(1)
                record=await self.repo.get('jobs',job['id'],owner)
                if record['data']['status'] not in ('pending','processing'):
                    return {'id':job['id'],**record['data']}
            return {'id':job['id'],'status':'processing','message':'PC에서 자료를 읽고 있습니다. 내 작업에서 진행 상태를 확인할 수 있습니다.'}
        if name=='get_job_status':
            row=await self.repo.get('jobs',a['job_id'],owner)
            if not row:raise HTTPException(404,'작업을 찾을 수 없습니다.')
            if row['data'].get('result',{}).get('file_id'):
                await self.files.read(owner,row['data']['result']['file_id'])
            return {'id':row['id'],**row['data']}
        if name in ('create_task','save_contact'):
            return await self.write_local(name, a, owner, thread_id, call_id)
        raise HTTPException(400,'허용되지 않은 업무 도구입니다.')

    @staticmethod
    def local_action_pending(row):
        uncertain = row['data'].get('status') == 'unknown'
        return {'error': ('저장 결과를 확인하지 못했습니다. 같은 요청이나 새 ID로 다시 생성하지 말고 작업 기록을 확인해 주세요.'
                          if uncertain else '같은 요청을 처리 중이거나 이전 처리가 중단되었습니다. 새 ID로 다시 생성하지 말고 작업 기록을 확인해 주세요.'),
                'status': 503 if uncertain else 409, 'operation_status': 'unknown' if uncertain else 'processing',
                'operation_id': row['id'], 'record_id': row['data'].get('record_id')}

    async def write_local(self, name, args, owner, thread_id, call_id):
        if any(not isinstance(value, str) or not value or len(value) > 300 for value in (owner, thread_id, call_id)):
            raise HTTPException(400, '저장 요청을 식별할 대화·호출 ID가 필요합니다.')
        if name == 'create_task':
            payload = {'title': checked_text(args.get('title'), '제목', 200, required=True),
                       'description': checked_text(args.get('description', ''), '설명', 10000), 'due_at': args.get('due_at')}
            if payload['due_at'] is not None:
                checked_text(payload['due_at'], '기한', 200)
        else:
            payload = {key: checked_text(args.get(key, ''), key, 2000, required=key == 'name')
                       for key in ('name', 'company', 'email', 'phone', 'memo')}
        fingerprint = hashlib.sha256(json.dumps([name, payload], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        action_id = hashlib.sha256(json.dumps([owner, thread_id, call_id]).encode()).hexdigest()
        # Existing ChatKit success records remain reusable, but cannot silently
        # accept a different operation/payload under the old call ID.
        legacy = await self.repo.get('tool_actions', f'{thread_id}:{call_id}', owner)
        if legacy and legacy['data'].get('result'):
            result = legacy['data']['result']
            if legacy['data'].get('name') != name or any(result.get(key) != value for key, value in payload.items()):
                raise HTTPException(409, '같은 호출의 내용이나 작업 종류를 변경할 수 없습니다.')
            return result
        row = await self.repo.get('tool_actions', action_id, owner)
        fresh = False
        if not row:
            try:
                row = await self.repo.insert('tool_actions', action_id, owner, {
                    'name': name, 'request_hash': fingerprint, 'status': 'processing',
                    'record_id': str(uuid5(NAMESPACE_URL, 'salesos-record:' + action_id)), 'created_at': now()})
                fresh = True
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
                row = await self.repo.get('tool_actions', action_id, owner)
        if not row or row['data'].get('name') != name or row['data'].get('request_hash') != fingerprint:
            raise HTTPException(409, '같은 호출의 내용이나 작업 종류를 변경할 수 없습니다.')
        if row['data'].get('status') == 'succeeded':
            return row['data']['result']
        if not fresh:
            return self.local_action_pending(row)
        # Claim first; no side effect precedes the unique owner-scoped claim.
        # Stable IDs also prevent duplication if a DB response is lost.
        record_id = row['data']['record_id']
        stamp = row['data']['created_at']
        data = {**payload, 'created_at': stamp}
        if name == 'create_task':
            data['status'] = 'pending'
        try:
            await self.repo.insert('tasks' if name == 'create_task' else 'contacts', record_id, owner, data)
            result = {'id': record_id, 'saved': True, **data}
            if name == 'save_contact':
                setting = await self.repo.get('settings', f'{owner}:notion_contacts', owner)
                result['notion_status'] = 'not_configured'
                if setting:
                    job_id = str(uuid5(NAMESPACE_URL, 'salesos-notion-contact:' + action_id))
                    await self.repo.insert('jobs', job_id, owner, {
                        'kind': 'notion_contact', 'title': 'Notion 명함첩 반영', 'status': 'pending', 'contact_id': record_id,
                        'parent_page_id': setting['data']['page_id'], 'thread_id': thread_id, 'created_at': stamp, 'updated_at': stamp})
                    result.update(notion_status='pending', job_id=job_id)
            completed = await self.repo.cas(row, {**row['data'], 'status': 'succeeded', 'result': result, 'updated_at': now()})
            if completed:
                return result
        except Exception:
            # Do not replay partial writes automatically. Inspect the claim below
            # in case completion was committed but its response was lost.
            pass
        try:
            current = await self.repo.get('tool_actions', action_id, owner)
            if current and current['data'].get('status') == 'succeeded':
                return current['data']['result']
            if current and current['data'].get('status') == 'processing':
                await self.repo.cas(current, {**current['data'], 'status': 'unknown', 'updated_at': now()})
        except Exception:
            pass  # A still-processing durable claim also prevents a blind retry.
        return self.local_action_pending({**row, 'data': {**row['data'], 'status': 'unknown'}})


    async def google_write_request(self, owner, provider, subject, method, url, *, connection_id=None, **kwargs):
        # Keep existing Providers refresh/permission handling, but bind this request
        # to its captured credential. An account switch must not retarget a write.
        before = await self.providers.connection(owner, provider, connection_id)
        if before['data'].get('subject') != subject:
            raise HTTPException(409, '연결 계정이 변경되어 요청을 중단했습니다.')
        token = await self.providers.google_token(owner, provider, connection_id)
        after = await self.providers.connection(owner, provider, connection_id)
        if after['data'].get('subject') != subject or before['data'].get('version') != after['data'].get('version'):
            raise HTTPException(409, '연결 계정이 변경되어 요청을 중단했습니다.')
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                response = await client.request(method, url, headers={'Authorization': 'Bearer ' + token}, **kwargs)
        except httpx.HTTPError:
            raise HTTPException(503, 'Google 요청의 반영 여부를 확인하지 못했습니다.') from None
        if response.status_code >= 300:
            status = response.status_code if response.status_code in (400, 401, 403, 404, 409, 429) else 502
            raise HTTPException(status, 'Google 요청을 완료하지 못했습니다. 연결 권한과 대상을 확인해 주세요.')
        try:
            return response.json()
        except (ValueError, TypeError):
            raise HTTPException(502, 'Google 응답을 확인하지 못했습니다.') from None

    async def finish_google_write(self, row, status, result):
        # CAS protects a concurrent replay verifying the same remote operation.
        for _ in range(3):
            if row['data'].get('status') == 'succeeded': return row['data']['result']
            updated = await self.repo.cas(row, {**row['data'], 'status': status, 'result': result, 'updated_at': now()})
            if updated: return result
            row = await self.repo.get('google_writes', row['id'], row['owner_id'])
            if not row: break
        raise HTTPException(409, '처리 기록이 변경되었습니다. 대상을 조회해 반영 여부를 확인해 주세요.')

    async def write_google(self, name, args, owner, thread_id, call_id):
        payload = checked_sheet_update(args) if name == 'update_sheet_range' else checked_calendar_event(args)
        if any(not isinstance(value, str) or not value or len(value) > 300 for value in (owner, thread_id, call_id)):
            raise HTTPException(400, '변경 요청을 식별할 대화·호출 ID가 필요합니다.')
        provider = 'google_sheets' if name == 'update_sheet_range' else 'google_calendar'
        connection = await self.providers.connection(owner, provider, args.get('connection_id'))
        connection_id = connection['data'].get('connection_id')
        subject = connection['data'].get('subject')
        if not isinstance(subject, str) or not subject:
            raise HTTPException(409, '연결한 Google 계정을 다시 확인해 주세요.')
        key = hashlib.sha256(json.dumps([owner, thread_id, call_id]).encode()).hexdigest()
        fingerprint = hashlib.sha256(json.dumps([name, payload], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        row = await self.repo.get('google_writes', key, owner)
        fresh = False
        if not row:
            try:
                row = await self.repo.insert('google_writes', key, owner, {'name': name, 'provider': provider, 'subject': subject, 'connection_id': connection_id,
                    'request_hash': fingerprint, 'status': 'pending', 'created_at': now()})
                fresh = True
            except HTTPException as exc:
                if exc.status_code != 409: raise
                row = await self.repo.get('google_writes', key, owner)
        if (not row or row['data'].get('request_hash') != fingerprint or row['data'].get('subject') != subject
                or (row['data'].get('connection_id') is not None and row['data']['connection_id'] != connection_id)):
            raise HTTPException(409, '같은 호출의 대상·내용·계정을 변경할 수 없습니다.')
        if row['data']['status'] in ('succeeded', 'failed'): return row['data']['result']
        if name == 'update_sheet_range':
            url = f"https://sheets.googleapis.com/v4/spreadsheets/{payload['spreadsheet_id']}/values/{quote(payload['range'], safe='')}"
            result = {'saved': True, 'spreadsheet_id': payload['spreadsheet_id'], 'range': payload['range'],
                'updated_cells': sum(len(item) for item in payload['values']), 'url': f"https://docs.google.com/spreadsheets/d/{payload['spreadsheet_id']}", 'operation_id': key}
            body = {'range': payload['range'], 'majorDimension': 'ROWS', 'values': payload['values']}
        else:
            url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
            event_id = 'salesos' + uuid5(NAMESPACE_URL, key).hex
            body = {**payload, 'id': event_id, 'extendedProperties': {'private': {'salesos_request': fingerprint}}}
            result = {'saved': True, 'event_id': event_id, 'calendar_id': 'primary', 'title': payload['summary'],
                'start_at': payload['start']['dateTime'], 'end_at': payload['end']['dateTime'], 'operation_id': key}
        if fresh:
            try:
                if name == 'update_sheet_range':
                    data = await self.google_write_request(owner, provider, subject, 'PUT', url, connection_id=connection_id,
                        params={'valueInputOption': 'RAW'}, json=body)
                    if not isinstance(data, dict) or not isinstance(data.get('updatedCells'), int):
                        raise HTTPException(502, '시트 변경 응답을 확인하지 못했습니다.')
                    result['updated_cells'] = data['updatedCells']
                else:
                    data = await self.google_write_request(owner, provider, subject, 'POST', url, connection_id=connection_id,
                        params={'sendUpdates': 'none'}, json=body)
                    if not same_calendar_event(data, body):
                        raise HTTPException(502, '일정 생성 응답을 확인하지 못했습니다.')
                    if isinstance(data.get('htmlLink'), str) and data['htmlLink'].startswith('https://www.google.com/calendar/'):
                        result['url'] = data['htmlLink']
                return await self.finish_google_write(row, 'succeeded', result)
            except HTTPException as exc:
                if exc.status_code in (400, 401, 403, 404):
                    return await self.finish_google_write(row, 'failed', {'error': exc.detail, 'status': exc.status_code, 'operation_id': key})
                # A timeout/5xx/409 may have committed. Never blindly repeat a PUT
                # or POST, even across processes; read the bounded target instead.
        try:
            if name == 'update_sheet_range':
                data = await self.google_write_request(owner, provider, subject, 'GET', url, connection_id=connection_id,
                    params={'valueRenderOption': 'UNFORMATTED_VALUE', 'dateTimeRenderOption': 'SERIAL_NUMBER'})
                verified = isinstance(data, dict) and same_sheet_values(data.get('values', []), payload['values'])
            else:
                data = await self.google_write_request(owner, provider, subject, 'GET', url + '/' + event_id, connection_id=connection_id)
                verified = same_calendar_event(data, body)
                if verified and isinstance(data.get('htmlLink'), str) and data['htmlLink'].startswith('https://www.google.com/calendar/'):
                    result['url'] = data['htmlLink']
            if verified:
                return await self.finish_google_write(row, 'succeeded', {**result, 'verified_after_retry': True})
        except HTTPException:
            pass
        return await self.finish_google_write(row, 'unknown', {'status': 503, 'operation_id': key,
            'error': '반영 여부를 확인하지 못했습니다. 새 쓰기를 반복하지 말고 Google에서 해당 범위나 일정을 조회해 주세요.'})
