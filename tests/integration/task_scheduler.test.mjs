import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readRuntimeSourceSync as readFileSync} from '../fixtures/runtime_source.mjs';
const source=readFileSync('infra/task_scheduler.js','utf8');
function setup(native=true) {
  let clock=0, boosted=0, ordinary=0;
  const context=vm.createContext({performance:{now:()=>clock},setTimeout:callback=>{ordinary++;queueMicrotask(callback);},scheduler:native?{yield:()=>{boosted++;return Promise.resolve();}}:undefined});
  vm.runInContext(source,context);
  return {context,advance:ms=>clock+=ms,counts:()=>({boosted,ordinary})};
}
test('ordinary tasks break consecutive boosted continuations',async()=>{
  const s=setup();
  for(let i=0;i<8;i++) await s.context.RRTaskScheduler.yield();
  assert.deepEqual(s.counts(),{boosted:6,ordinary:2});
});
test('elapsed page work forces an ordinary task before the count limit',async()=>{
  const s=setup();s.advance(25);
  await s.context.RRTaskScheduler.yield();
  assert.deepEqual(s.counts(),{boosted:0,ordinary:1});
});
test('missing and rejected scheduler APIs still yield with ordinary tasks',async()=>{
  const s=setup(false);await s.context.RRTaskScheduler.yield();
  assert.equal(s.counts().ordinary,1);
  s.context.scheduler={yield:()=>Promise.reject(new Error('unavailable'))};
  await s.context.RRTaskScheduler.yield();assert.equal(s.counts().ordinary,2);
});
