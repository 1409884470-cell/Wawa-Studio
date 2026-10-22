"""Isolated regression tests. No real API requests or production writes."""
import copy
import sys
import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import app

BIBLE={'synopsis':'故事','characters':[{'name':'林舟','identity':'档案员','motivation':'查案'}],
       'immutable_facts':['死者十三人','凶手陈某'],'world_rules':['无复活'],'ending':'真相揭晓'}


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();p=Path(self.tmp.name)
        self.patches=[patch.object(app,k,v) for k,v in {'ROOT':p,'CONFIG':p/'config','PROJECTS':p/'projects','EXPORTS':p/'exports','PIPELINE':app.Pipeline(),'GATE':app.RequestGate()}.items()]
        for x in self.patches:x.start()
        app.initialize()
        c=copy.deepcopy(app.DEFAULTS);c['generation'].update(request_delay=0,max_retries=1,repair_attempts=0,concurrency=1)
        app.atomic_json(app.CONFIG/'settings.json',c)

    def tearDown(self):
        for x in reversed(self.patches):x.stop()
        self.tmp.cleanup()

    def book(self,**kw):
        return app.add_book({'book_name':'测试书','chapter_count':2,'chapter_words_target':200,**kw})

    def model(self,task,context,stop):
        if task.startswith('规划一部'):return copy.deepcopy(BIBLE)
        if task.startswith('只规划'):
            import re
            start,end=map(int,re.search(r'第 (\d+) 至 (\d+)',task).groups())
            return {'chapters':[{'chapter_num':n,'title':f'标题{n}','summary':f'独立事件{n}','opening':'承接','ending':'悬念','state_changes':['线索推进']} for n in range(start,end+1)]}
        if task.startswith('审查输入'):return {'approved':True,'issues':[]}
        return {'approved':True,'issues':[],'summary':'事件已发生','state':{'location':'案发地'}}

    def produce(self,b,response='正文'*110):
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=response if isinstance(response,Exception) else None,return_value=response):
            app.PIPELINE.process(b['id'])
        return app.meta(b['id'])

    def test_auto_retry_eventually_exports_whole_book(self):
        b=self.book();calls=[]
        def output(*args,**kwargs):
            calls.append(1)
            if len(calls)==1:raise app.ModelError('read timed out')
            return '正文'*110
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=output),patch.object(app,'retry_delay',return_value=.05):
            app.PIPELINE.start(False);app.PIPELINE.thread.join(10)
            if app.PIPELINE.running:app.PIPELINE.pause();app.PIPELINE.thread.join(5)
        self.assertEqual(app.meta(b['id'])['status'],'completed')
        self.assertEqual(len(calls),3)

    def test_partial_timeout_continues_preserved_prefix(self):
        b=self.book(chapter_count=1);prefix='已有剧情完整保留。'*12
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=app.ModelError('断流',False,prefix,True)):
            app.PIPELINE.process(b['id'])
        waiting=app.meta(b['id']);self.assertEqual(waiting['status'],'retry_wait')
        self.assertEqual(waiting['chapters'][0]['status'],'partial')
        draft=app.project_dir(b['id'])/'drafts'/'0001.txt';self.assertEqual(draft.read_text(encoding='utf-8'),prefix)
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',return_value='后续剧情。'*25) as model:
            app.PIPELINE.process(b['id'])
        text=app.chapter_path(b['id'],1).read_text(encoding='utf-8')
        self.assertTrue(text.startswith(prefix));self.assertEqual(model.call_count,1)
        self.assertIn('已有正文',model.call_args.args[0][1]['content'])
        self.assertEqual(app.meta(b['id'])['status'],'completed')

    def test_empty_first_response_recovers_in_same_book(self):
        b=self.book(chapter_count=1)
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=['','新的正文。'*45]):
            app.PIPELINE.process(b['id'])
        self.assertEqual(app.meta(b['id'])['status'],'completed')

    def test_review_timeout_reuses_paid_draft(self):
        b=self.book(chapter_count=1)
        def review(task,ctx,stop):
            if task.startswith('检查本章'):raise app.ModelError('审核超时')
            return self.model(task,ctx,stop)
        with patch.object(app,'structured',side_effect=review),patch.object(app,'llm',return_value='正文'*110):app.PIPELINE.process(b['id'])
        self.assertEqual(app.meta(b['id'])['status'],'retry_wait')
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm') as writer:app.PIPELINE.process(b['id'])
        writer.assert_not_called();self.assertEqual(app.meta(b['id'])['status'],'completed')

    def test_permanent_auth_failure_does_not_loop(self):
        b=self.produce(self.book(),app.ModelError('HTTP 401',False))
        self.assertEqual(b['status'],'failed')

    def test_retry_wait_does_not_block_other_book(self):
        a=self.book(book_name='故障书');b=self.book(book_name='正常书',chapter_count=1)
        def output(*args,**kwargs):
            if app.REQUEST_CONTEXT.pid==a['id']:raise app.ModelError('timeout')
            return '正文'*110
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=output):
            app.PIPELINE.start(False)
            import time
            until=time.time()+5
            while time.time()<until and app.meta(b['id'])['status']!='completed':time.sleep(.02)
            self.assertEqual(app.meta(a['id'])['status'],'retry_wait')
            self.assertEqual(app.meta(b['id'])['status'],'completed')
            app.book_action(a['id'],'pause');app.PIPELINE.thread.join(3)
        self.assertFalse(app.PIPELINE.running);self.assertEqual(app.meta(a['id'])['status'],'paused')

    def test_batch_deletes_waiting_and_archived_without_resurrection(self):
        a=self.produce(self.book(),app.ModelError('timeout'));b=self.produce(self.book(chapter_count=1))
        app.book_action(b['id'],'delete')
        result=app.batch_action([a['id'],b['id'],a['id']],'erase')
        self.assertEqual(len(result),2);self.assertTrue(all(x['success'] for x in result))
        app.initialize();self.assertEqual(app.queue()['items'],[])
        self.assertEqual(len(list((app.ROOT/'trash').iterdir())),2)

    def test_batch_prevalidates_all_ids(self):
        b=self.book()
        with self.assertRaises(ValueError):app.batch_action([b['id'],'missing'],'erase')
        self.assertTrue(app.project_dir(b['id']).exists())

    def test_retry_wait_survives_initialize_and_global_pause(self):
        b=self.produce(self.book(),app.ModelError('timeout'))
        app.initialize();self.assertEqual(app.meta(b['id'])['status'],'retry_wait')
        app.PIPELINE.pause();self.assertEqual(app.meta(b['id'])['status'],'paused')

    def test_success_persists_and_exports(self):
        b=self.produce(self.book());self.assertEqual(b['status'],'completed')
        self.assertTrue(all(c['status']=='completed' for c in b['chapters']))
        self.assertTrue((app.EXPORTS/b['export_file']).exists())

    def test_failure_is_not_completed(self):
        b=self.produce(self.book(),RuntimeError('offline'));self.assertEqual(b['status'],'failed')
        self.assertEqual(list(app.EXPORTS.iterdir()),[])

    def test_empty_or_short_text_fails(self):
        b=self.produce(self.book(),'');self.assertEqual(b['status'],'retry_wait');self.assertFalse(b['export_file'])

    def test_review_rejection_records_warning_and_continues(self):
        original=self.model
        def reviewer(task,ctx,stop):
            if task.startswith('检查本章'):return {'approved':False,'issues':['女主改名'],'summary':'','state':{}}
            return original(task,ctx,stop)
        self.model=reviewer
        b=self.produce(self.book());self.assertEqual(b['status'],'completed')
        self.assertTrue(app.chapter_path(b['id'],2).exists())
        self.assertFalse(b['chapters'][0]['review']['quality_passed'])

    def test_outline_rejection_auto_repairs_without_replanning(self):
        b=self.book();original=self.model;repairs=[]
        def model(task,ctx,stop):
            if task.startswith('审查输入'):return {'approved':False,'issues':['三年误写三十年']}
            if task.startswith('修订开篇'):
                repairs.append(ctx)
                return {'chapters':[{**c,'summary':c['summary']+'已修正年份'} for c in ctx['target_chapters']]}
            return original(task,ctx,stop)
        self.model=model
        b=self.produce(b)
        self.assertEqual(b['status'],'completed');self.assertEqual(len(repairs),1)
        self.assertTrue(b['opening_plan_reviewed'])
        self.assertTrue(all('已修正年份' in c['summary'] for c in b['chapters']))

    def test_only_first_fifteen_get_model_review(self):
        original=self.model;reviewed=[];batches=[]
        def model(task,ctx,stop):
            if task.startswith('检查本章'):reviewed.append(ctx['chapter']['chapter_num'])
            if task.startswith('只规划'):batches.append(task)
            return original(task,ctx,stop)
        self.model=model;b=self.produce(self.book(chapter_count=31))
        self.assertEqual(b['status'],'completed')
        self.assertEqual(reviewed,list(range(1,16)))
        self.assertEqual(len(batches),4)
        self.assertEqual(b['chapters'][15]['review']['mode'],'后段快速验收')

    def test_outline_audit_excludes_tail(self):
        original=self.model
        def model(task,ctx,stop):
            if task.startswith('审查输入'):
                self.assertEqual(len(ctx['chapters']),15)
                self.assertEqual(ctx['chapters'][-1]['chapter_num'],15)
            return original(task,ctx,stop)
        self.model=model;self.assertEqual(self.produce(self.book(chapter_count=20))['status'],'completed')

    def test_failed_repair_format_does_not_stop_production(self):
        original=self.model
        def model(task,ctx,stop):
            if task.startswith('审查输入'):return {'approved':False,'issues':['需要修订']}
            if task.startswith('修订开篇'):return {'chapters':[]}
            return original(task,ctx,stop)
        self.model=model;b=self.produce(self.book())
        self.assertEqual(b['status'],'completed')
        self.assertEqual(b['plan_review']['repairs'][0]['status'],'warning')

    def opening_book(self):
        b=self.book(chapter_count=16);calls=[0]
        def write(*args,**kwargs):
            calls[0]+=1
            if calls[0]==16:raise RuntimeError('simulate interruption after opening')
            return '正文'*110
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=write):app.PIPELINE.process(b['id'])
        return app.meta(b['id'])

    def test_opening_export_available_before_book_completed(self):
        b=self.opening_book()
        name=b['opening_export_file'];text=(app.EXPORTS/name).read_text(encoding='utf-8')
        self.assertIn('第15章',text);self.assertNotIn('第16章',text)
        b['status']='running';b['chapters'][15]['status']='pending';app.persist(b)
        self.assertTrue(app.export_opening(b));self.assertEqual(app.meta(b['id'])['status'],'running')
        self.assertEqual(app.queue()['items'][0]['opening_export_file'],name)

    def test_no_opening_export_before_fifteen(self):
        b=self.produce(self.book(chapter_count=14))
        self.assertNotIn('opening_export_file',b)
        self.assertFalse(any('__前15章__' in x.name for x in app.EXPORTS.iterdir()))

    def test_opening_export_edit_invalidation_and_regeneration(self):
        b=self.opening_book();name=b['opening_export_file']
        app.save_chapter(b['id'],16,'尾文'*110)
        self.assertTrue((app.EXPORTS/name).exists())
        app.save_chapter(b['id'],1,'开篇'*110)
        self.assertFalse((app.EXPORTS/name).exists());self.assertFalse(app.meta(b['id']).get('opening_export_file'))
        b=self.produce(app.meta(b['id']))
        self.assertTrue((app.EXPORTS/b['export_file']).exists());self.assertFalse(b.get('opening_export_file'))

    def test_language_rules_only_in_first_fifteen_prompts(self):
        b=self.book(chapter_count=16)
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',return_value='正文'*110) as model:
            app.PIPELINE.process(b['id'])
        prompts=[c.args[0][0]['content'] for c in model.call_args_list]
        self.assertEqual(len(prompts),16)
        self.assertTrue(all('精写章节语言自然化要求' in x for x in prompts[:15]))
        self.assertNotIn('精写章节语言自然化要求',prompts[15])
        book=app.meta(b['id'])
        self.assertTrue(app.context_for(book,book['chapters'][14])['language_rules'])
        self.assertEqual(app.context_for(book,book['chapters'][15])['language_rules'],'')

    def test_custom_polish_count_controls_requests_and_language_rules(self):
        app.save_settings({'generation':{'polish_chapters':2}})
        reviewed=[];original=self.model
        def model(task,ctx,stop):
            if task.startswith('检查本章'):reviewed.append(ctx['chapter']['chapter_num'])
            return original(task,ctx,stop)
        self.model=model;b=self.produce(self.book(chapter_count=4))
        self.assertEqual(b['status'],'completed');self.assertEqual(reviewed,[1,2])
        self.assertTrue(app.context_for(b,b['chapters'][1])['language_rules'])
        self.assertEqual(app.context_for(b,b['chapters'][2])['language_rules'],'')

    def test_full_book_polish_reviews_each_batch_and_every_chapter(self):
        app.save_settings({'generation':{'polish_chapters':1,'full_book_polish':True},'prompts':{'natural_style':'CUSTOM NATURAL','prompt_2':'CUSTOM STRICT'}})
        reviewed=[];planned=[];original=self.model
        def model(task,ctx,stop):
            if task.startswith('检查本章'):reviewed.append(ctx['chapter']['chapter_num'])
            if task.startswith('审查输入'):planned.extend(c['chapter_num'] for c in ctx['chapters'])
            return original(task,ctx,stop)
        with patch.object(app,'structured',side_effect=model),patch.object(app,'llm',return_value='正文'*110) as calls:
            b=self.book(chapter_count=17);app.PIPELINE.process(b['id'])
        b=app.meta(b['id']);self.assertEqual(b['status'],'completed')
        self.assertEqual(reviewed,list(range(1,18)));self.assertEqual(planned,list(range(1,18)))
        self.assertTrue(all('CUSTOM STRICT' in c.args[0][0]['content'] and 'CUSTOM NATURAL' in c.args[0][0]['content'] for c in calls.call_args_list))

    def test_zero_polish_uses_quick_mode_and_invalid_settings_are_rejected(self):
        app.save_settings({'generation':{'polish_chapters':0}})
        b=self.produce(self.book());self.assertEqual(b['status'],'completed')
        self.assertTrue(all(c['review']['mode']=='后段快速验收' for c in b['chapters']))
        for patch_value in [{'polish_chapters':-1},{'polish_chapters':101},{'full_book_polish':'true'}]:
            with self.assertRaises(ValueError):app.save_settings({'generation':patch_value})

    def test_resume_uses_checkpoint(self):
        b=self.book();original=self.model
        def model(task,ctx,stop):
            result=original(task,ctx,stop)
            if task.startswith('检查本章'):app.PIPELINE.stop.set()
            return result
        self.model=model;b=self.produce(b);self.assertEqual(b['status'],'paused');self.assertEqual(b['chapters'][0]['status'],'completed')
        self.model=original;app.PIPELINE.stop.clear()
        with patch.object(app,'structured',side_effect=self.model) as structured,patch.object(app,'llm',return_value='续文'*110) as llm:
            app.PIPELINE.process(b['id'])
        self.assertEqual(llm.call_count,1);self.assertEqual(structured.call_count,1)
        self.assertEqual(app.meta(b['id'])['status'],'completed')

    def test_stop_before_loop_cleans_running(self):
        app.PIPELINE.running=True;app.PIPELINE.stop.set();app.PIPELINE.run();self.assertFalse(app.PIPELINE.running)

    def test_real_scheduler_processes_two_books(self):
        self.book();self.book(book_name='第二本')
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',return_value='正文'*110):
            app.PIPELINE.start();app.PIPELINE.thread.join(10)
        self.assertFalse(app.PIPELINE.running)
        self.assertTrue(all(i['status']=='completed' for i in app.queue()['items']))

    def test_failed_book_does_not_block_next(self):
        self.book();self.book(book_name='第二本')
        original=self.model
        def mock(task,ctx,stop):
            if task.startswith('规划一部') and ctx['book_name']=='测试书':raise RuntimeError('simulated')
            return original(task,ctx,stop)
        with patch.object(app,'structured',side_effect=mock),patch.object(app,'llm',return_value='正文'*110):
            app.PIPELINE.start();app.PIPELINE.thread.join(10)
        self.assertEqual([i['status'] for i in app.queue()['items']],['failed','completed'])

    def test_chapter_repair_path(self):
        c=app.settings();c['generation']['repair_attempts']=1;app.atomic_json(app.CONFIG/'settings.json',c)
        b=self.book(chapter_count=1);original=self.model;reviews=[]
        def mock(task,ctx,stop):
            if task.startswith('检查本章'):
                reviews.append(ctx['draft'])
                if len(reviews)==1:return {'approved':False,'issues':['错误姓名'],'summary':'','state':{}}
            return original(task,ctx,stop)
        with patch.object(app,'structured',side_effect=mock),patch.object(app,'llm',side_effect=['错误'*110,'修订'*110]):
            app.PIPELINE.process(b['id'])
        self.assertEqual(len(reviews),2);self.assertEqual(app.meta(b['id'])['status'],'completed')
        self.assertEqual(app.chapter_path(b['id'],1).read_text(encoding='utf-8'),'修订'*110)

    def test_completed_book_does_not_export_after_tamper(self):
        b=self.produce(self.book());old=b['export_file']
        app.atomic_text(app.chapter_path(b['id'],1),'其他'*110)
        with self.assertRaises(ValueError):app.export_book(b)
        app.PIPELINE.reconcile(b);self.assertFalse((app.EXPORTS/old).exists())

    def test_concurrent_updates_are_atomic(self):
        b=self.book();barrier=threading.Barrier(2)
        def worker(changes):barrier.wait();app.update_item(b['id'],**changes)
        ts=[threading.Thread(target=worker,args=(d,)) for d in [{'completed_chapters':10},{'status':'paused'}]]
        for t in ts:t.start()
        for t in ts:t.join()
        q=app.queue()['items'][0];self.assertEqual(q['completed_chapters'],10);self.assertEqual(q['status'],'paused')

    def test_one_request_means_one(self):
        entered=threading.Event();release=threading.Event();guard=threading.Lock();active=[0,0]
        def fake(*args):
            with guard:active[0]+=1;active[1]=max(active)
            entered.set();release.wait(2)
            with guard:active[0]-=1
            return 'ok'
        with patch.object(app,'transport',side_effect=fake):
            ts=[threading.Thread(target=app.llm,args=([],threading.Event())) for _ in range(2)]
            for t in ts:t.start()
            entered.wait(2);release.set()
            for t in ts:t.join()
        self.assertEqual(active[1],1)

    def test_global_request_interval(self):
        import time
        c=app.settings();c['generation'].update(request_delay=.05,concurrency=3);app.atomic_json(app.CONFIG/'settings.json',c)
        starts=[]
        with patch.object(app,'transport',side_effect=lambda *a: starts.append(time.monotonic()) or 'ok'):
            ts=[threading.Thread(target=app.llm,args=([],threading.Event())) for _ in range(3)]
            for t in ts:t.start()
            for t in ts:t.join()
        self.assertTrue(all(b-a>=.045 for a,b in zip(starts,starts[1:])))

    def test_identical_titles_export_separately(self):
        a=self.produce(self.book());b=self.produce(self.book());self.assertNotEqual(a['export_file'],b['export_file']);self.assertEqual(len(list(app.EXPORTS.iterdir())),2)

    def test_edit_invalidates_export_and_successors(self):
        b=self.produce(self.book());old=b['export_file'];app.save_chapter(b['id'],1,'修改'*110)
        m=app.meta(b['id']);self.assertEqual(m['chapters'][0]['status'],'review');self.assertEqual(m['chapters'][1]['status'],'pending');self.assertFalse((app.EXPORTS/old).exists())
        self.assertEqual(len(list((app.project_dir(b['id'])/'export_history').iterdir())),1)

    def test_same_length_external_edit_invalidates(self):
        b=self.produce(self.book());app.atomic_text(app.chapter_path(b['id'],1),'其他'*110);app.PIPELINE.reconcile(b)
        self.assertTrue(all(c['status']=='pending' for c in b['chapters']))

    def test_archive_not_reimported(self):
        b=self.book();app.book_action(b['id'],'delete');app.initialize();self.assertEqual(app.queue()['items'],[]);self.assertTrue(app.project_dir(b['id']).exists())

    def test_restart_recovery(self):
        b=self.book();app.update_item(b['id'],status='running');app.initialize();self.assertEqual(app.queue()['items'][0]['status'],'paused')

    def test_legacy_retained_for_review(self):
        app.atomic_json(app.PROJECTS/'legacy'/'meta.json',{'book_name':'旧书','status':'pending','chapters':[]})
        app.initialize();self.assertEqual(app.queue()['items'][0]['status'],'needs_review')

    def test_bad_json_not_silent_empty_queue(self):
        (app.CONFIG/'queue.json').write_text('{',encoding='utf-8')
        with self.assertRaises(RuntimeError):app.queue()

    def test_path_restrictions(self):
        for pid in ('../config',r'C:\temp','a/b','a\\b','..'):
            with self.assertRaises(ValueError):app.project_dir(pid)

    def test_endpoint_v4(self):
        self.assertEqual(app.endpoint('https://host/api/paas/v4'),'https://host/api/paas/v4/chat/completions')
        self.assertEqual(app.endpoint('https://host'),'https://host/v1/chat/completions')

    def test_settings_preserve_key_and_validate(self):
        app.save_settings({'api':{'api_key':'secret'}});app.save_settings({'api':{'api_key':''}})
        self.assertEqual(app.settings()['api']['api_key'],'secret');self.assertNotIn('api_key',app.public_settings()['api'])
        with self.assertRaises(ValueError):app.save_settings({'generation':{'concurrency':0}})

    def test_plan_rejects_duplicate_and_wrong_number(self):
        c={'chapter_num':1,'title':'a','summary':'same','opening':'a','ending':'b','state_changes':['x']}
        with self.assertRaises(ValueError):app.validate_plan([c,{**c,'chapter_num':2}],1,2,[])
        with self.assertRaises(ValueError):app.validate_plan([{**c,'chapter_num':'1'}],1,1,[])
        with self.assertRaises(ValueError):app.validate_plan([c],1,2,[])

    def test_truncated_response_rejected(self):
        class Response:
            headers={'Content-Type':'application/json'}
            consumed=False
            def isclosed(self):return self.consumed
            def read1(self,n):self.consumed=True;return self.read()
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self):return json.dumps({'choices':[{'finish_reason':'length','message':{'content':'partial'}}]}).encode()
        with patch.object(app.urllib.request,'urlopen',return_value=Response()):
            with self.assertRaises(app.ModelError):app.transport(app.settings()['api'],[],.5,6000)

    def test_progress_download_only_saved_prefix(self):
        b=self.opening_book()
        app.atomic_text(app.project_dir(b['id'])/'drafts'/'0016.txt','半章不应导出')
        filename,text=app.progress_snapshot(b['id'])
        self.assertIn('当前15章',filename);self.assertIn('第15章',text)
        self.assertNotIn('第16章',text);self.assertNotIn('半章不应导出',text)
        app.atomic_text(app.chapter_path(b['id'],3),'外部修改')
        filename,text=app.progress_snapshot(b['id'])
        self.assertIn('当前2章',filename)

    def test_library_single_entry_final_replaces_stage(self):
        b=self.opening_book();stage=b['opening_export_file']
        self.assertEqual(len(app.library_entries()),1)
        self.assertEqual(app.library_entries()[0]['kind'],'opening')
        b=self.produce(b)
        entries=app.library_entries();self.assertEqual(len(entries),1)
        self.assertEqual(entries[0]['kind'],'full');self.assertFalse((app.EXPORTS/stage).exists())
        self.assertTrue(list((app.project_dir(b['id'])/'export_history').glob('opening-*.txt')))

    def test_archived_book_can_be_deleted_from_library(self):
        b=self.produce(self.book());app.book_action(b['id'],'delete')
        self.assertEqual(len(app.library_entries()),1)
        app.book_action(b['id'],'erase');app.initialize()
        self.assertEqual(app.library_entries(),[]);self.assertEqual(app.queue()['items'],[])
        self.assertTrue(list((app.ROOT/'trash').glob('*')))

    def test_pause_and_resume_one_book_while_another_runs(self):
        cfg=app.settings();cfg['generation']['concurrency']=2;app.atomic_json(app.CONFIG/'settings.json',cfg)
        a=self.book(book_name='A');b=self.book(book_name='B')
        entered={name:threading.Event() for name in ('A','B')};release=threading.Event()
        counts={'A':0,'B':0};guard=threading.Lock()
        def write(messages,*args,**kwargs):
            name='A' if '"book_name": "A"' in messages[-1]['content'] else 'B'
            with guard:counts[name]+=1;count=counts[name]
            if count==1:
                entered[name].set();self.assertTrue(release.wait(5))
            return '正文'*110
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=write):
            app.PIPELINE.start();self.assertTrue(entered['A'].wait(3));self.assertTrue(entered['B'].wait(3))
            app.book_action(a['id'],'pause');self.assertEqual(app.meta(a['id'])['status'],'pausing')
            release.set();app.PIPELINE.thread.join(5)
            self.assertEqual(app.meta(a['id'])['status'],'paused')
            self.assertEqual(app.meta(b['id'])['status'],'completed')
            # Keep another task in flight while resuming the paused task.
            c=self.book(book_name='C');hold=threading.Event();ready=threading.Event()
            original=app.PIPELINE.process
            def process(pid):
                if pid==c['id']:ready.set();hold.wait(5)
                return original(pid)
            with patch.object(app.PIPELINE,'process',side_effect=process):
                app.PIPELINE.start(resume_paused=False);self.assertTrue(ready.wait(3))
                app.book_action(a['id'],'retry')
                import time
                deadline=time.monotonic()+4
                while app.meta(a['id'])['status']!='completed' and time.monotonic()<deadline:time.sleep(.02)
                self.assertEqual(app.meta(a['id'])['status'],'completed')
                hold.set();app.PIPELINE.thread.join(5)
        self.assertEqual(counts['A'],2)  # Paid first draft reused on resume.

    def test_delete_active_waits_for_checkpoint(self):
        b=self.book();entered=threading.Event();release=threading.Event()
        def write(*a,**k):entered.set();release.wait(5);return '正文'*110
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=write):
            app.PIPELINE.start();self.assertTrue(entered.wait(3));app.book_action(b['id'],'delete')
            self.assertEqual(app.meta(b['id'])['status'],'pausing')
            release.set();app.PIPELINE.thread.join(5)
        self.assertEqual(app.queue()['items'],[])
        self.assertTrue((app.project_dir(b['id'])/'drafts'/'0001.txt').exists())
        app.initialize();self.assertEqual(app.queue()['items'],[])

    def test_finish_requested_during_request_is_not_lost(self):
        b=self.book(chapter_count=100);calls=[0]
        def write(*a,**k):
            calls[0]+=1
            if calls[0]==1:app.book_action(b['id'],'finish')
            return '正文'*110
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=write):app.PIPELINE.process(b['id'])
        book=app.meta(b['id']);self.assertEqual(book['status'],'completed')
        self.assertEqual(book['chapter_count'],2);self.assertEqual(calls[0],2)
        self.assertTrue(book['chapters'][-1]['is_final'])

    def test_budget_closes_before_target_and_never_exceeds_limit(self):
        b=self.book(chapter_count=100,chapter_words_target=2000);book=app.meta(b['id']);book['bible']=copy.deepcopy(BIBLE)
        book['chapters']=[{'chapter_num':n,'status':'completed','words':14500} for n in range(1,16)]
        app.PIPELINE.prepare_closing(book)
        self.assertTrue(book['closing']);self.assertEqual(book['chapter_count'],18)
        c=book['chapters'][15];target,maximum=app.set_budget(book,c)
        self.assertLessEqual(maximum,250000-217500)

    def test_finish_keeps_unreviewed_paid_checkpoint(self):
        b=app.meta(self.book(chapter_count=100)['id']);b['bible']=copy.deepcopy(BIBLE)
        c={'chapter_num':1,'status':'review','words':0}
        b['chapters']=[c];b['finish_requested']=True
        app.PIPELINE.prepare_closing(b)
        self.assertIs(b['chapters'][0],c);self.assertFalse(b.get('closing'))

    def test_overlong_chapter_kept_without_compression_call(self):
        b=self.book(chapter_count=1);text='冗长'*400
        with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',return_value=text) as write:app.PIPELINE.process(b['id'])
        self.assertEqual(app.meta(b['id'])['status'],'completed');self.assertEqual(write.call_count,1)
        self.assertEqual(app.chapter_path(b['id'],1).read_text(encoding='utf-8'),text)

    def test_full_budget_run_for_short_and_long_model_outputs(self):
        import re
        for ratio in (.8,1.1):
            b=self.book(chapter_count=100,chapter_words_target=2000)
            def write(messages,*a,**k):
                match=re.search(r'目标 (\d+) 字',messages[-1]['content'])
                return '文'*int(int(match.group(1))*ratio)
            with patch.object(app,'structured',side_effect=self.model),patch.object(app,'llm',side_effect=write):app.PIPELINE.process(b['id'])
            result=app.meta(b['id']);self.assertEqual(result['status'],'completed',result.get('error'))
            self.assertGreaterEqual(app.completed_words(result),200000)
            self.assertLessEqual(app.completed_words(result),250000)
            self.assertLessEqual(result['chapter_count'],100)
            self.assertTrue(result['chapters'][-1]['is_final'])

    def test_total_limit_preserves_draft_without_model_call(self):
        b=app.meta(self.book()['id']);b['chapters']=[{'status':'completed','words':249800}]
        chapter={'chapter_num':2,'words_target':200,'words_limit':200};text='原文'*300
        with patch.object(app,'llm') as model:
            with self.assertRaisesRegex(ValueError,'全书剩余'):app.fit_length(b,chapter,text,threading.Event())
            model.assert_not_called()
        self.assertEqual((app.project_dir(b['id'])/'drafts'/'0002.txt').read_text(encoding='utf-8'),text)

    def test_tail_split_preserves_text_and_shifts_plan_within_100(self):
        b=app.meta(self.book(chapter_count=100)['id']);b['bible']=copy.deepcopy(BIBLE)
        b['chapters']=[{'chapter_num':n,'title':str(n),'summary':str(n),'opening':'开','ending':'尾','state_changes':['推进'],'status':'completed' if n<16 else 'pending','words':0} for n in range(1,101)]
        c=b['chapters'][15];c.update(status='review',words_target=200,words_limit=230)
        text='甲'*209+'。\n\n'+'乙'*209+'。'
        with patch.object(app,'llm') as model:
            first=app.fit_length(b,c,text,threading.Event());model.assert_not_called()
        self.assertEqual(first,'甲'*209+'。');self.assertEqual(len(b['chapters']),100)
        follow=b['chapters'][16];self.assertEqual(follow['status'],'review')
        self.assertEqual(b['chapters'][17]['title'],'17');self.assertEqual(b['chapters'][-1]['title'],'99')
        self.assertEqual((app.project_dir(b['id'])/'drafts'/'0017.txt').read_text(encoding='utf-8'),'乙'*209+'。')
        self.assertEqual([c['chapter_num'] for c in b['chapters']],list(range(1,101)))

    def test_normalize_body_and_limits(self):
        self.assertEqual(app.words('第1章 标题\n\n甲 乙\n丙。'),4)
        with self.assertRaises(ValueError):self.book(chapter_count=101)
        with self.assertRaises(ValueError):self.book(book_words_target=250000,book_words_limit=220000)
        b=app.meta(self.book()['id']);b['chapters']=[{'status':'completed','words':249850}]
        _,maximum=app.set_budget(b,{'chapter_num':2});self.assertEqual(maximum,150)

    def test_edit_idle_book_during_other_production(self):
        b=self.produce(self.book());app.PIPELINE.running=True
        app.save_chapter(b['id'],1,'修改'*110)
        self.assertEqual(app.meta(b['id'])['status'],'paused')
        app.PIPELINE.running=False

    def test_http_security_and_defaults(self):
        server=app.Server(('127.0.0.1',0),app.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            req=urllib.request.Request(base+'/api/config')
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
            self.assertEqual(error.exception.code,403)
            for origin in [None,'https://other.invalid']:
                req=urllib.request.Request(base+'/api/default-prompts',headers={'X-Session-Token':app.SESSION_TOKEN,**({'Origin':origin} if origin else {})})
                if origin:
                    with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(req)
                else:
                    with urllib.request.urlopen(req) as r:self.assertIn('style',json.load(r)['data'])
            b=self.produce(self.book())
            headers={'X-Session-Token':app.SESSION_TOKEN}
            req=urllib.request.Request(base+'/api/download-progress?id='+b['id'],headers=headers)
            with urllib.request.urlopen(req) as r:
                self.assertIn('attachment',r.headers['Content-Disposition'])
                self.assertEqual(r.read().decode('utf-8'),app.progress_snapshot(b['id'])[1])
            req=urllib.request.Request(base+'/api/exports',headers=headers)
            with urllib.request.urlopen(req) as r:
                entries=json.load(r)['data'];self.assertEqual(len(entries),1);self.assertEqual(entries[0]['kind'],'full')
        finally:server.shutdown();server.server_close();thread.join()


class IdeaStyleTests(unittest.TestCase):
    setUp=FactoryTests.setUp
    tearDown=FactoryTests.tearDown
    model=FactoryTests.model
    def test_random_styles_expand_seed_and_persist_into_writing(self):
        cfg=app.settings();cfg['prompts']['idea_expand']='CUSTOM EXPAND';cfg['prompts']['idea_style_番茄风']='CUSTOM TOMATO'
        app.atomic_json(app.CONFIG/'settings.json',cfg)
        captured=[]
        def reply(task,context,stop):
            captured.append((task,context))
            return {'ideas':[{'book_name':'书'+str(i),'core_premise':'补充后的故事','protagonist':'林舟'} for i in range(4)]}
        with patch.object(app,'structured',side_effect=reply):result=app.generate_ideas({'count':4,'seed':'原始种子','platform_style':'随机混合'})
        self.assertEqual({i['platform_style'] for i in result['ideas']},set(app.IDEA_STYLES))
        self.assertIn('CUSTOM EXPAND',captured[0][0]);self.assertEqual(captured[0][1]['seed'],'原始种子')
        tomato=next(i for i in result['ideas'] if i['platform_style']=='番茄风');self.assertEqual(tomato['style_brief'],'CUSTOM TOMATO')
        book=app.add_book({**tomato,'chapter_count':2,'chapter_words_target':200});project=app.read_json(app.project_dir(book['id'])/'meta.json')
        self.assertEqual(app.context_for(project)['style_brief'],'CUSTOM TOMATO')
        with patch.object(app,'structured',side_effect=self.model) as model:
            with patch.object(app,'llm',return_value='正文'*110):app.PIPELINE.process(book['id'])
        planning=next(c for c in model.call_args_list if c.args[0].startswith('规划一部'))
        self.assertEqual(planning.args[1]['platform_style'],'番茄风')

    def test_single_style_and_invalid_style(self):
        with patch.object(app,'structured',return_value={'ideas':[{'book_name':'书','core_premise':'故事'}]}) as model:
            result=app.generate_ideas({'count':1,'platform_style':'起点风'})
        self.assertEqual(result['ideas'][0]['platform_style'],'起点风')
        self.assertEqual(model.call_args.args[1]['style_assignments'][0]['风格'],'起点风')
        with self.assertRaises(ValueError):app.generate_ideas({'count':1,'platform_style':'unknown'})

class PromptAndBatchTests(unittest.TestCase):
    setUp=FactoryTests.setUp
    tearDown=FactoryTests.tearDown
    def test_all_registered_writer_prompts_are_editable_and_recorded(self):
        values={k:'CUSTOM-'+k for k in app.DEFAULTS['prompts']}
        app.save_settings({'prompts':values})
        for key,value in values.items():self.assertEqual(app.prompt_text(key),value)
        usage=app.read_json(app.CONFIG/'prompt-usage.json')
        for key,value in values.items():self.assertEqual(usage[key]['text'],value)
        app.save_settings({'prompts':{'natural_style':''}});self.assertEqual(app.prompt_text('natural_style'),'')
    def test_style_specific_title_instruction_and_batch_controls(self):
        app.save_settings({'prompts':{'idea_title_飞卢风':'TITLE-CUSTOM 强钩子'}})
        with patch.object(app,'structured',return_value={'ideas':[{'book_name':'强钩子书名','core_premise':'故事'}]}) as model:
            idea=app.generate_ideas({'count':1,'platform_style':'飞卢风'})['ideas'][0]
        self.assertEqual(model.call_args.args[1]['style_assignments'][0]['书名要求'],'TITLE-CUSTOM 强钩子')
        b=app.add_book(idea);self.assertEqual(b['title_style'],'TITLE-CUSTOM 强钩子')
        self.assertTrue(app.batch_action([b['id']],'pause')[0]['success']);self.assertEqual(app.meta(b['id'])['status'],'paused')
        with patch.object(app.PIPELINE,'start'):
            self.assertTrue(app.batch_action([b['id']],'retry')[0]['success'])
            self.assertTrue(app.batch_action([b['id']],'finish')[0]['success'])
        self.assertTrue(app.meta(b['id'])['finish_requested'])

if __name__=='__main__':unittest.main()
