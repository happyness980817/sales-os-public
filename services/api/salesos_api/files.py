import asyncio
import base64
import csv
import hashlib
import io
import json
import zipfile
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4
import httpx
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from openpyxl import load_workbook
from pypdf import PdfReader
from .config import ROOT, Settings
from .repository import Repository, now

MIMES={'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'}


def extract_document(filename: str, content: bytes, max_chars=60000):
    extension=Path(filename).suffix.lower()
    mime=MIMES.get(extension)
    if not mime:
        raise HTTPException(415,'지원하는 파일은 TXT, MD, CSV, XLSX, 텍스트 PDF, JPG, PNG, WebP입니다.')
    if mime.startswith('image/'):
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.width*image.height>25_000_000:
                    raise HTTPException(413,'이미지 해상도가 너무 큽니다.')
                actual=Image.MIME.get(image.format)
                if actual != mime:
                    raise HTTPException(415,'파일의 확장자와 실제 이미지 형식이 다릅니다.')
                image.verify()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            raise HTTPException(415,'읽을 수 있는 이미지 파일이 아닙니다.') from None
        return {'text':'','mime_type':mime,'truncated':False,'image':True}
    truncated=False
    try:
        if extension in ('.txt','.md','.csv'):
            text=content.decode('utf-8-sig')
        elif extension=='.pdf':
            if not content.startswith(b'%PDF-'):
                raise HTTPException(415,'올바른 PDF 파일이 아닙니다.')
            pdf=PdfReader(io.BytesIO(content))
            if pdf.is_encrypted:
                raise HTTPException(415,'암호화된 PDF는 읽을 수 없습니다.')
            truncated=len(pdf.pages)>40
            text='\n\n'.join(f'[페이지 {i+1}]\n{page.extract_text() or ""}' for i,page in enumerate(pdf.pages[:40]))
            if not any((page.extract_text() or '').strip() for page in pdf.pages[:40]):
                raise HTTPException(415,'텍스트가 없는 PDF입니다. 스캔 문서 OCR은 아직 지원하지 않습니다.')
        else:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if sum(entry.file_size for entry in archive.infolist())>60*1024*1024 or len(archive.infolist())>2000:
                    raise HTTPException(413,'압축을 푼 문서 크기가 제한을 초과합니다.')
                if any('vbaproject' in entry.filename.lower() for entry in archive.infolist()):
                    raise HTTPException(415,'매크로가 포함된 문서는 지원하지 않습니다.')
            workbook=load_workbook(io.BytesIO(content),read_only=True,data_only=True)
            lines=[]; char_count=0
            for sheet in list(workbook)[:20]:
                lines.append(f'[시트: {sheet.title}]')
                for idx,row in enumerate(sheet.iter_rows(values_only=True)):
                    if idx>=2000:
                        truncated=True;break
                    line='\t'.join('' if cell is None else str(cell) for cell in row[:100])
                    lines.append(line);char_count+=len(line)
                    if char_count>max_chars:
                        truncated=True;break
                if char_count>max_chars:break
            truncated=truncated or len(workbook.sheetnames)>20
            workbook.close()
            text='\n'.join(lines)+'\n[수식은 실행하지 않았으며 저장된 계산값만 읽었습니다.]'
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(415,'파일 내용을 추출하지 못했습니다. UTF-8 텍스트 또는 지원 문서인지 확인해 주세요.') from None
    return {'text':text[:max_chars],'mime_type':mime,'truncated':truncated or len(text)>max_chars,'image':False}


class Files:
    def __init__(self,settings: Settings,repo: Repository):
        self.settings,self.repo=settings,repo
        self.directory=ROOT/'.runtime/files'

    async def create(self,owner,filename,content,*,source=None,images_only=False):
        filename=Path(filename.replace('\\','/')).name[:180]
        if not content or len(content)>self.settings.max_file_bytes:
            raise HTTPException(413,f'파일은 비어 있지 않은 {self.settings.max_file_bytes / (1024 * 1024):g}MB 이하 파일로 선택해 주세요.')
        if images_only and Path(filename).suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):
            raise HTTPException(415,'채팅 첨부는 JPG, PNG, WebP 이미지를 지원합니다.')
        extracted=await asyncio.to_thread(extract_document,filename,content,self.settings.max_extract_chars)
        id='atc_'+uuid4().hex
        object_path=f'{owner}/{id}/{filename}'
        if self.repo.db:
            self.directory.mkdir(parents=True,exist_ok=True)
            (self.directory/id).write_bytes(content)
        else:
            key=self.settings.supabase_service_key
            headers={'apikey':key,'Content-Type':extracted['mime_type'],'x-upsert':'false'}
            if not key.startswith('sb_secret_'):headers['Authorization']='Bearer '+key
            async with httpx.AsyncClient(timeout=30) as client:
                response=await client.post(self.settings.supabase_url+'/storage/v1/object/salesos-files/'+quote(object_path,safe='/'),headers=headers,content=content)
            if response.status_code>=400:
                raise HTTPException(503,'파일 보관소에 저장하지 못했습니다.')
        row={'filename':filename,'object_path':object_path,'sha256':hashlib.sha256(content).hexdigest(),'size':len(content),
            **extracted,'source':source,'read_at':now()}
        await self.repo.insert('files',id,owner,row)
        return {'id':id,**row}

    async def read(self,owner,id):
        row=await self.repo.get('files',id,owner)
        if not row:
            raise HTTPException(404,'파일을 찾을 수 없습니다.')
        source=row['data'].get('source') or {}
        if source.get('device_id'):
            device=await self.repo.get('devices',source['device_id'],owner)
            root=await self.repo.get('roots',f"{source['device_id']}:{source['root_id']}",owner)
            if not device or device['data'].get('revoked') or not root or not root['data'].get('enabled') or (source.get('root_version') and root['data'].get('version') != source['root_version']):
                raise HTTPException(403,'해제된 PC 폴더의 자료는 다시 사용할 수 없습니다.')
        return {'id':id,**row['data']}

    async def bytes(self,owner,id):
        record=await self.read(owner,id)
        if self.repo.db:
            return (self.directory/id).read_bytes()
        key=self.settings.supabase_service_key
        headers={'apikey':key}
        if not key.startswith('sb_secret_'):headers['Authorization']='Bearer '+key
        async with httpx.AsyncClient(timeout=30) as client:
            res=await client.get(self.settings.supabase_url+'/storage/v1/object/authenticated/salesos-files/'+quote(record['object_path'],safe='/'),headers=headers)
        if res.status_code>=400:
            raise HTTPException(503,'보관 파일을 읽지 못했습니다.')
        return res.content

    async def image_data_url(self,owner,id):
        record=await self.read(owner,id)
        return 'data:'+record['mime_type']+';base64,'+base64.b64encode(await self.bytes(owner,id)).decode()
