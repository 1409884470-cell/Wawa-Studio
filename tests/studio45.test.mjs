import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePrompts,LEGACY_PROMPTS,PROMPTS,renderPrompt} from '../prompt-catalog.mjs';
import {buildCoverPrompt} from '../cover-prompt.mjs';
import {SCORE_LIMITS,titleScore} from '../packaging-ai.mjs';
test('only untouched legacy prompts migrate, customized templates remain literal',()=>{
 const saved=normalizePrompts({score:LEGACY_PROMPTS.score,coverStyle:'USER {v0}'});assert.equal(saved.score,PROMPTS.score.template);assert.equal(saved.coverStyle,'USER {v0}');
 assert.equal(renderPrompt({promptTemplates:saved},'coverStyle',{v0:'$&书名'}),'USER $&书名');
});
test('all editable cover layers are honored without forced old composition',()=>{
 const p=buildCoverPrompt({coverTemplate:'BASE {书名}',coverLayout:'LAYOUT',coverMood:'MOOD',coverExtra:'EXTRA'},{title:'书名',scene:'SCENE'});
 assert.equal(p,'BASE 书名\n作者署名：未指定\n画风：未指定\nEXTRA');assert.doesNotMatch(p,/LAYOUT|SCENE|MOOD/);assert.doesNotMatch(p,/80%|七猫/);
 assert.equal(SCORE_LIMITS.hook,45);assert.equal(titleScore({scores:{contentFit:20,hook:45,genre:10,readability:15,distinctive:10},reason:'评分依据'}),100);
});
