// Run: node tests/account-sync.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const {test} = require('node:test');

const localHtml = path.join(__dirname, '..', '简历投递跟踪.html');
const html = fs.readFileSync(fs.existsSync(localHtml) ? localHtml : path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);
const core = script.slice(0, script.indexOf('//提交新增/编辑'));

function harness(storage = new Map()){
    const localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
    };
    const element = {textContent:'', className:''};
    return new Function('localStorage', 'crypto', 'document', 'window', `${core}
        return {
            domain: AccountDomain, getAccounts, saveAccounts, getAccountChanges,
            mergeRecords, applyRemotePayload, serialisePayload, parseRemotePayload,
            hashPassword, syncWithGithub,
            pending: () => githubChangesPending,
            stubNetwork(read, write){
                fetchGithubFile = read; writeGithubFile = write;
                render = () => {}; renderAdminAccounts = () => {};
            }
        };
    `)(localStorage, webcrypto, {getElementById:()=>element}, {location:{protocol:'https:',href:'https://doublelb.github.io/resume-delivery-tracker/'}});
}

function remote(accounts){
    return {version:3, accounts, records:[{id:1, owner:'lbw', updatedAt:10, company:'existing'}], deletedAccounts:{}, deletedRecords:{}};
}

test('password reset survives manual sync, reload and stale browser cache', async () => {
    const storage = new Map();
    const app = harness(storage);
    const old = {passwordHash:await app.hashPassword('123456'), updatedAt:10};
    const cloud = remote({lbw:old});
    app.applyRemotePayload(cloud);
    const local = app.getAccounts();
    local.lbw = await app.domain.changePassword(local.lbw, 'new-password');
    app.saveAccounts(local, {markForSync:true});
    assert.equal(app.pending(), true);
    assert.equal(cloud.accounts.lbw.passwordHash, old.passwordHash, 'local saving must not alter cloud');
    const reloaded = harness(storage);
    assert.equal(reloaded.pending(), true, 'pending state survives refresh');
    const merged = reloaded.mergeRecords(cloud, cloud.records, {}, reloaded.getAccounts(), {}, reloaded.getAccountChanges());
    const saved = reloaded.parseRemotePayload(reloaded.serialisePayload(merged));
    assert.equal(saved.accounts.lbw.passwordHash, await app.hashPassword('new-password'));
    assert.notEqual(saved.accounts.lbw.passwordHash, await app.hashPassword('123456'));
    assert.deepEqual(saved.records, cloud.records, 'password reset preserves applications');
    reloaded.applyRemotePayload(saved);
    assert.equal(reloaded.pending(), false);
    assert.deepEqual(reloaded.getAccountChanges(), {});
    const staleSync = reloaded.mergeRecords(saved, cloud.records, {}, {lbw:old}, {}, {});
    assert.equal(staleSync.accounts.lbw.passwordHash, saved.accounts.lbw.passwordHash);
});

test('concurrent different password resets report conflict; identical retry succeeds', async () => {
    const app = harness();
    const base = {passwordHash:await app.hashPassword('123456'),updatedAt:10};
    const first = await app.domain.changePassword(base, 'first-password');
    const second = await app.domain.changePassword(base, 'second-password');
    assert.throws(() => app.domain.merge({lbw:second},{lbw:first},{},{},{lbw:{base,value:first}}), /E_ACCOUNT_CONFLICT/);
    assert.equal(app.domain.merge({lbw:first},{lbw:first},{},{},{lbw:{base,value:first}}).accounts.lbw.passwordHash, first.passwordHash);
});

test('admin credential migration and admin password reset use persisted hash', async () => {
    const app = harness();
    app.applyRemotePayload(remote({}));
    const accounts = app.getAccounts();
    assert.equal(accounts.admin.passwordHash, await app.hashPassword('admin'));
    accounts.admin = await app.domain.changePassword(accounts.admin, 'admin-new-password');
    app.saveAccounts(accounts, {markForSync:true});
    const merged = app.mergeRecords(remote({}), [], {}, app.getAccounts(), {}, app.getAccountChanges());
    app.applyRemotePayload(merged);
    assert.equal(app.getAccounts().admin.passwordHash, await app.hashPassword('admin-new-password'));
    assert.notEqual(app.getAccounts().admin.passwordHash, await app.hashPassword('admin'));
});

test('renaming migrates record owner, deletion prevents stale resurrection', () => {
    const app = harness();
    const base = {passwordHash:'existing',updatedAt:10};
    const newAccount = {...base,revision:'rename',updatedAt:20};
    const renamed = app.mergeRecords(remote({lbw:base}), [{id:1,owner:'lbw2',updatedAt:20}], {}, {lbw2:newAccount}, {lbw:20}, {lbw:{base,value:null},lbw2:{base:null,value:newAccount}});
    assert.equal(renamed.accounts.lbw, undefined);
    assert.equal(renamed.records[0].owner, 'lbw2');
    const deleted = app.mergeRecords({...renamed, deletedAccounts:{lbw:20,lbw2:30},records:[],deletedRecords:{1:30}}, renamed.records, {}, renamed.accounts, {}, {});
    assert.equal(deleted.accounts.lbw2, undefined);
    assert.equal(deleted.records.length, 0);
});

test('manual upload uses changed password; edits made during upload stay pending', async () => {
    const storage = new Map([['resume_delivery_github_config',JSON.stringify({repo:'DoubleLB/resume-delivery-tracker',token:'test-token'})]]);
    const app = harness(storage);
    const old = {passwordHash:await app.hashPassword('123456'),updatedAt:10};
    const cloud = remote({lbw:old});
    app.applyRemotePayload(cloud);
    const local = app.getAccounts();
    local.lbw = await app.domain.changePassword(old,'first-new-password');
    app.saveAccounts(local,{markForSync:true});
    let uploaded;
    app.stubNetwork(async()=>({sha:'expected-sha',payload:cloud,canWrite:true}),async (config,payload,sha)=>{
        assert.equal(sha,'expected-sha');
        uploaded=payload;
        const next = app.getAccounts();
        next.lbw = await app.domain.changePassword(next.lbw,'second-new-password');
        app.saveAccounts(next,{markForSync:true});
        return true;
    });
    assert.equal(await app.syncWithGithub(),true);
    assert.equal(uploaded.accounts.lbw.passwordHash,await app.hashPassword('first-new-password'));
    assert.equal(app.getAccounts().lbw.passwordHash,await app.hashPassword('second-new-password'));
    assert.equal(app.pending(),true);
    app.stubNetwork(async()=>({sha:'next-sha',payload:uploaded,canWrite:true}),async()=>true);
    // Update the cloud baseline for the completed first write without discarding the newer local edit.
    // The production journal must acknowledge a successful upload before the next manual retry.
    assert.equal(await app.syncWithGithub(),true);
    assert.equal(app.pending(),false);
});

test('actual login handler accepts synced new password and rejects old password, including admin', async () => {
    const app = harness();
    const oldUser = {passwordHash:await app.hashPassword('123456'),updatedAt:10};
    const accounts = app.domain.withAdmin({lbw:oldUser});
    accounts.lbw = await app.domain.changePassword(oldUser, 'lbw-new-password');
    accounts.admin = await app.domain.changePassword(accounts.admin, 'admin-new-password');
    const cloud = remote(accounts);
    const storage = new Map();
    const elements = new Map();
    const element = id => {
        if(!elements.has(id)) elements.set(id, {
            id, value:'', dataset:{}, hidden:false, disabled:false,
            classList:{add(){},remove(){},toggle(){}}, listeners:{},
            addEventListener(name, handler){this.listeners[name]=handler;}, reset(){}, setAttribute(){}
        });
        return elements.get(id);
    };
    const localStorage = {
        getItem:key=>storage.get(key) ?? null,
        setItem:(key,value)=>storage.set(key,String(value)),
        removeItem:key=>storage.delete(key)
    };
    const setup = new Function('localStorage','crypto','document','window','setTimeout','clearTimeout', `${script}
        loadGithubDataForLogin = async () => applyRemotePayload(${JSON.stringify(cloud)});
        render = () => {}; renderAdminAccounts = () => {}; clearForm = () => {};
        return {setAuthMode};
    `)(localStorage,webcrypto,{getElementById:element,querySelectorAll:()=>[]},{},()=>0,()=>{});
    async function login(mode,username,password){
        storage.delete('resume_delivery_current_user');
        setup.setAuthMode(mode);
        element('authUsername').value=username;
        element('authPassword').value=password;
        await element('authForm').listeners.submit({preventDefault(){}});
        return storage.get('resume_delivery_current_user');
    }
    assert.equal(await login('login','lbw','123456'),undefined);
    assert.equal(await login('login','lbw','lbw-new-password'),'lbw');
    assert.equal(await login('admin','admin','admin'),undefined);
    assert.equal(await login('admin','admin','admin-new-password'),'admin');
});
