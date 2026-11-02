import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { userPath } from './paths.mjs';

export const phoneKey = phone => crypto.createHash('sha256').update(String(phone || '')).digest('hex');
export function accountPaths(phone) {
  const root=userPath('profiles','accounts',phoneKey(phone));
  return {root,profileDir:path.join(root,'browser'),sessionFile:path.join(root,'session.json')};
}
// Only the previously selected account owns the legacy shared browser.
export function migrateAccountProfile(phone) {
  if(!phone)return;
  const dest=accountPaths(phone);
  for(const [old,target] of [[userPath('profiles','wawa'),dest.profileDir],[userPath('profiles','wawa-session.json'),dest.sessionFile]]){
    if(fs.existsSync(old)&&!fs.existsSync(target)){fs.mkdirSync(dest.root,{recursive:true});fs.renameSync(old,target);}
  }
}
export function clearAccountProfile(phone) {
  const {root}=accountPaths(phone),parent=path.resolve(userPath('profiles','accounts'));
  if(path.dirname(path.resolve(root))!==parent)throw new Error('账号目录异常');
  fs.rmSync(root,{recursive:true,force:true});
}
