"""Private line-delimited IPC worker. No web server and no second application UI."""
import sys,json,threading,traceback
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import app as engine
engine.initialize()

def dispatch(method,data):
    if method=='snapshot':
        with engine.LOCK,engine.PIPELINE.lock:
            return {'queue':engine.queue(),'library':engine.library_entries(),'running':engine.PIPELINE.running,'logs':engine.PIPELINE.logs[-60:]}
    if method=='private-config':return engine.settings()
    if method=='config':return engine.public_settings()
    if method=='defaults':return engine.DEFAULTS
    if method=='prompt-usage':return engine.read_json(engine.CONFIG/'prompt-usage.json',{})
    if method=='save-config':engine.save_settings(data);return engine.public_settings()
    if method=='add':return engine.add_book(data)
    if method=='start':engine.PIPELINE.start();return True
    if method=='pause':engine.PIPELINE.pause();return True
    if method=='action':return engine.book_action(data['id'],data['action'])
    if method=='batch':return engine.batch_action(data['ids'],data['action'])
    if method=='project':return engine.meta(data['id'])
    if method=='chapter':return engine.chapter_path(data['id'],engine.number(data['chapter'],1,500,'章节')).read_text(encoding='utf-8')
    if method=='save-chapter':engine.save_chapter(data['id'],engine.number(data['chapter'],1,500,'章节'),data['content']);return True
    if method=='export':
        name,content=engine.progress_snapshot(data['id']);return {'name':name,'content':content}
    if method=='complete-export':
        with engine.LOCK:
            book=engine.meta(data['id'])
            if book['status']!='completed':raise ValueError('作品尚未完整生成')
            engine.export_book(book)
            return str(engine.EXPORTS/book['export_file'])
    if method=='ideas':return engine.generate_ideas(data)
    if method=='test-api':return engine.test_api(data)
    raise ValueError('未知写作操作')

# Long model calls cannot block snapshots, pause, settings, or the UI heartbeat.
from concurrent.futures import ThreadPoolExecutor
pool=ThreadPoolExecutor(max_workers=2)
output_lock=threading.Lock()
def respond(request):
    try:result={'id':request['id'],'ok':True,'data':dispatch(request['method'],request.get('data') or {})}
    except Exception as e:result={'id':request.get('id'),'ok':False,'error':str(e)}
    with output_lock:print(json.dumps(result,ensure_ascii=False),flush=True)
for line in sys.stdin:
    try:
        request=json.loads(line)
        if request.get('method') in ('ideas','test-api'):pool.submit(respond,request)
        else:respond(request)
    except Exception as e:
        with output_lock:print(json.dumps({'id':None,'ok':False,'error':str(e)},ensure_ascii=False),flush=True)
engine.PIPELINE.pause()
pool.shutdown(wait=False,cancel_futures=True)
