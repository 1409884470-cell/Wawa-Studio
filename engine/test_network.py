"""Real local HTTP sockets: framing, buffering, deadlines and partial output."""
import copy
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from network_client import receive,ReceiveError


def chunk(text='',reason=None,**extra):
    return ('data: '+json.dumps({'choices':[{'index':0,'delta':{'content':text,**extra},'finish_reason':reason}]},ensure_ascii=False)+'\n\n').encode()


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.packets=[];self.delay_headers=0;self.content_type='text/event-stream';self.http_status=200;self.sent_request=None;self.content_length=None
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_POST(self):
                owner.sent_request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                time.sleep(owner.delay_headers)
                try:
                    self.send_response(owner.http_status);self.send_header('Content-Type',owner.content_type)
                    if owner.content_length is not None:self.send_header('Content-Length',str(owner.content_length))
                    self.end_headers()
                    for delay,data in owner.packets:
                        time.sleep(delay);self.wfile.write(data);self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError,OSError):pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}/v1/chat/completions'
        self.api={'model':'test','api_key':'test-secret','timeout':.4,'idle_timeout':.15,'total_timeout':2,'stream':True}
        self.reports=[]

    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()

    def call(self):return receive(self.url,self.api,[],.5,4096,lambda s,p:self.reports.append((s,p)))

    def test_stream_chinese_bytes_split_and_reasoning_excluded(self):
        payload=chunk('',reasoning_content='不要导出思考')+chunk('你好世界')+chunk('',reason='stop')
        self.packets=[(0,bytes([n])) for n in payload]
        self.assertEqual(self.call(),'你好世界');self.assertTrue(self.sent_request['stream'])
        self.assertEqual(self.reports[-1][0]['stage'],'接收完成')

    def test_heartbeats_keep_slow_generation_alive(self):
        self.packets=[(.07,b': heartbeat\n\n')]*8+[(0,chunk('最终正文')),(0,b'data: [DONE]\n\n')]
        self.assertEqual(self.call(),'最终正文')
        self.assertGreater(self.reports[-1][0]['elapsed_seconds'],self.api['timeout'])

    def test_partial_then_idle_timeout_preserves_text_without_retry(self):
        self.packets=[(0,chunk('已生成的正文')),(.3,chunk('后文',reason='stop'))]
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertEqual(error.exception.partial,'已生成的正文');self.assertFalse(error.exception.retryable)
        self.assertIn('读取超时',str(error.exception));self.assertIn('接收流式内容',str(error.exception))

    def test_truncated_stream_is_not_success(self):
        self.packets=[(0,chunk('断开的半章'))]
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertIn('没有收到正常结束标记',str(error.exception));self.assertEqual(error.exception.partial,'断开的半章')

    def test_json_response_accepted_when_proxy_ignores_stream(self):
        self.content_type='application/json'
        body=json.dumps({'choices':[{'message':{'content':'普通返回'},'finish_reason':'stop'}]}).encode()
        self.packets=[(0,body[:20]),(0,body[20:])]
        self.assertEqual(self.call(),'普通返回')

    def test_content_length_json_auto_closed_socket(self):
        self.content_type='application/json'
        body=json.dumps({'choices':[{'message':{'content':'完整JSON'},'finish_reason':'stop'}]}).encode()
        self.content_length=len(body);self.packets=[(0,body)]
        self.assertEqual(self.call(),'完整JSON')

    def test_app_persists_partial_without_secrets_in_diagnostics(self):
        import tempfile
        import app
        self.packets=[(0,chunk('已经返回的半章'))]
        with tempfile.TemporaryDirectory() as temp,patch.object(app,'ROOT',Path(temp)):
            with self.assertRaises(app.ModelError) as error:app.transport({**self.api,'base_url':self.url},[],.5,4096)
            self.assertFalse(error.exception.retryable)
            folder=Path(temp)/'logs'/'network_history'
            self.assertEqual(next(folder.glob('*.partial.txt')).read_text(encoding='utf-8'),'已经返回的半章')
            record=next(folder.glob('*.json')).read_text(encoding='utf-8')
            self.assertNotIn('test-secret',record);self.assertNotIn('已经返回的半章',record)

    def test_total_timeout_even_with_heartbeats(self):
        self.api['total_timeout']=.24
        self.packets=[(.04,b': heartbeat\n\n')]*10
        started=time.monotonic()
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertLess(time.monotonic()-started,.6);self.assertEqual(error.exception.partial,'')

    def test_silent_header_timeout_records_actual_limit(self):
        self.api['timeout']=.1;self.delay_headers=.3
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertIn('等待响应头',str(error.exception));self.assertIn('0.1/0.15/2',str(error.exception))

    def test_upstream_error_in_200_does_not_expose_body(self):
        self.packets=[(0,b'data: {"error":{"message":"SECRET_BODY"}}\n\n')]
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertNotIn('SECRET_BODY',str(error.exception));self.assertIn('返回错误',str(error.exception))

    def test_local_proxy_bypasses_environment_proxy(self):
        self.packets=[(0,chunk('直连成功',reason='stop'))]
        with patch.dict(os.environ,{'http_proxy':'http://127.0.0.1:1','HTTP_PROXY':'http://127.0.0.1:1','no_proxy':'','NO_PROXY':''}):
            self.assertEqual(self.call(),'直连成功')

    def test_token_truncation_retains_partial_and_fails(self):
        self.packets=[(0,chunk('被截断正文',reason='length'))]
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertIn('长度限制',str(error.exception));self.assertTrue(error.exception.recoverable);self.assertEqual(error.exception.partial,'被截断正文')

    def test_http_error_has_status_and_no_credentials(self):
        self.http_status=504;self.packets=[(0,b'test-secret')]
        with self.assertRaises(ReceiveError) as error:self.call()
        self.assertIn('HTTP 504',str(error.exception));self.assertNotIn('test-secret',str(error.exception))


if __name__=='__main__':unittest.main()
