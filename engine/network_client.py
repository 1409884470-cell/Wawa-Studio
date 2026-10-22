"""Incremental Chat Completions receiver, with no provider SDK dependency."""
import codecs
import http.client
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request


class ReceiveError(Exception):
    def __init__(self,message,retryable=True,partial=''):
        super().__init__(message)
        self.retryable=retryable and not bool(partial)
        self.recoverable=retryable
        self.partial=partial


def receive(url,api,messages,temperature,max_tokens,report=lambda *a:None):
    started=time.monotonic();parts=[];size=0;phase='等待响应头';finished=False
    first=float(api['timeout']);idle=float(api.get('idle_timeout',300));total=float(api.get('total_timeout',1800))
    streaming=api.get('stream',True)
    def status(state):
        report({'stage':state,'elapsed_seconds':round(time.monotonic()-started,1),
                'received_bytes':size,'received_chars':sum(map(len,parts)),
                'first_timeout':first,'idle_timeout':idle,'total_timeout':total,'stream':streaming},''.join(parts))
    def fail(reason,retryable=True):
        raise ReceiveError(f'{reason}；阶段：{phase}；已等 {time.monotonic()-started:.1f} 秒；收到 {size} 字节 / {sum(map(len,parts))} 字正文；首包/空闲/总时限 {first:g}/{idle:g}/{total:g} 秒',retryable,''.join(parts))
    def event(data):
        nonlocal finished
        if data.strip()=='[DONE]':finished=True;return
        if not data.strip():return
        try:value=json.loads(data)
        except ValueError:fail('流式数据不是有效 JSON')
        if not isinstance(value,dict):fail('流式数据结构不正确')
        if value.get('error'):fail('反代在响应中返回错误（查看对应反代日志）')
        choices=value.get('choices') or []
        if not isinstance(choices,list) or any(not isinstance(c,dict) for c in choices):fail('choices 格式错误')
        if not choices:return  # Usage or heartbeat event.
        choice=next((c for c in choices if c.get('index',0)==0),None)
        if choice is None:return
        delta=choice.get('delta',choice.get('message',{})) or {}
        if not isinstance(delta,dict):fail('正文片段格式错误')
        content=delta.get('content')
        if isinstance(content,list):content=''.join(x.get('text','') for x in content if isinstance(x,dict) and isinstance(x.get('text',''),str))
        if isinstance(content,str):parts.append(content)
        reason=choice.get('finish_reason')
        if reason=='length':fail('模型输出达到长度限制，需续接')
        if reason=='content_filter':fail('模型输出被过滤',False)
        if reason in ('tool_calls','function_call'):fail('正文接口意外返回工具调用',False)
        if reason=='stop':finished=True
    req=urllib.request.Request(url,data=json.dumps({'model':api['model'],'messages':messages,
        'temperature':temperature,'max_tokens':max_tokens,'stream':streaming}).encode(),
        headers={'Content-Type':'application/json','Accept':'text/event-stream, application/json',
                 **({'Authorization':'Bearer '+api['api_key']} if api.get('api_key') else {})})
    status(phase)
    try:
        # Local Antigravity must bypass environment/system HTTP proxies.
        local=urllib.parse.urlsplit(url).hostname in ('localhost','127.0.0.1','::1')
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({})).open if local else urllib.request.urlopen
        with opener(req,timeout=min(first,total)) as response:
            phase='等待首批数据';status(phase)
            sock=getattr(getattr(getattr(response,'fp',None),'raw',None),'_sock',None)
            decoder=codecs.getincrementaldecoder('utf-8-sig')()
            mode='sse' if 'text/event-stream' in response.headers.get('Content-Type','').lower() else None
            buffer='';json_body='';fields=[];event_type='';last_byte=time.monotonic()
            def dispatch():
                nonlocal fields,event_type
                if event_type=='error':fail('反代发送了流式错误事件')
                if fields:event('\n'.join(fields))
                fields=[];event_type=''
            def consume(chunk):
                nonlocal buffer,json_body,mode,event_type
                if mode is None:
                    buffer+=chunk
                    stripped=buffer.lstrip()
                    if not stripped:return
                    if stripped.startswith(('{','[')):mode='json';json_body=buffer;buffer='';return
                    if ':' not in stripped and '\n' not in stripped:return
                    mode='sse';chunk='';
                if mode=='json':json_body+=chunk;return
                buffer+=chunk
                while '\n' in buffer and not finished:
                    line,buffer=buffer.split('\n',1);line=line.rstrip('\r')
                    if not line:dispatch()
                    elif line.startswith(':'):continue
                    elif line.startswith('data:'):fields.append(line[5:].lstrip(' '))
                    elif line.startswith('event:'):event_type=line[6:].strip()
            while not finished:
                now=time.monotonic();budget=total-(now-started)
                if budget<=0:fail('请求达到总时限')
                silence=(idle if size else first)-(now-last_byte if size else now-started)
                if silence<=0:fail('接收等待超时')
                if response.isclosed():raw=b''
                else:
                    if sock:sock.settimeout(min(budget,silence))
                    raw=response.read1(16384)
                if not raw:
                    consume(decoder.decode(b'',final=True))
                    if mode=='sse':
                        if buffer:consume('\n\n')
                        else:dispatch()
                    break
                size+=len(raw);last_byte=time.monotonic()
                if size>16*1024*1024:fail('响应超过安全接收上限',False)
                phase='接收流式内容' if mode!='json' else '接收普通 JSON'
                consume(decoder.decode(raw));status(phase)
            if mode=='json':
                event(json_body)
                if not finished:fail('普通 JSON 缺少正常结束标记')
            elif not finished:fail('连接已关闭，但没有收到正常结束标记')
            if not ''.join(parts).strip():fail('模型没有返回正文')
            status('接收完成')
            return ''.join(parts).strip()
    except ReceiveError:
        status('接收失败');raise
    except urllib.error.HTTPError as exc:
        exc.close()
        status(f'HTTP {exc.code}')
        fail(f'模型服务返回 HTTP {exc.code}',exc.code in (408,429) or exc.code>=500)
    except (TimeoutError,socket.timeout):
        status('读取超时')
        fail('请求达到总时限' if time.monotonic()-started>=total-.01 else '读取超时')
    except (OSError,urllib.error.URLError,http.client.HTTPException) as exc:
        status('网络连接中断');fail('网络连接中断（'+type(exc).__name__+'）')
    except (ValueError,KeyError,TypeError,UnicodeError):
        status('响应格式错误');fail('响应格式不兼容')
