import { ReplyRenderer } from "../src/reply-renderer.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { registerProfileTools } from "../src/profiles.js";
import { ToolRegistry } from "../src/tools.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { Message } from "../src/domain.js";
const alice = "474858037970993152", bot = "1470866073862672434";
const message = (id: string, author = alice): Message => ({ id, server: "s", channel: "c", author, text: "explicit profile update", authorName: author === alice ? "Teddio" : "Slopbot", isBot: author === bot });

test("profiles persist flexible fields, attribution, locks and safe undo", async t => {
 const store = new SQLiteStore(); t.after(() => store.close());
 await store.ingest(message("initial")); await store.ingest(message("other", bot));
 store.editProfile(message("initial"),alice,"interests",["gardening","TypeScript"],"one");
 assert.equal(store.profile("s",alice).fields[0]?.editor,alice);
 store.editProfile(message("other",bot),alice,"interests",["Rust"],"two");
 assert.equal(store.profile("s",alice).fields[0]?.editor,bot);
 store.lockProfile("s",alice,alice,false);
 assert.throws(()=>store.editProfile(message("other",bot),alice,"real_name","Invented","three"),/disabled/);
 assert.throws(()=>store.lockProfile("s",alice,bot,true),/owner/);
 assert.throws(()=>store.undoProfile(message("other",bot),alice,"two","undo"),/owner/);
 assert.throws(()=>store.undoProfile(message("initial"),alice,"one","stale"),/newer/);
 store.undoProfile(message("initial"),alice,"two","undo");
 assert.deepEqual(store.profile("s",alice).fields[0]?.value,["gardening","TypeScript"]);
 assert.equal(store.profileHistory("s",alice,alice).length,3);
});

test("profile aliases resolve a stable ID and source edits invalidate custom information", async t => {
 const store = new SQLiteStore(); t.after(() => store.close());
 await store.ingest(message("source"));
 store.editProfile(message("source"),alice,"nicknames",["Oscar"],"alias");
 assert.equal(store.findPeople("s","Oscar")[0]?.id,alice);
 assert.equal(store.findPeople("elsewhere","Oscar").length,0);
 await store.revise({...message("source"),text:"corrected"});
 assert.equal(store.findPeople("s","Oscar").length,0);
 assert.equal(store.profile("s",alice).fields.length,0);
 assert.equal(store.profileHistory("s",alice,alice).length,0);
});

test("reply rendering resolves known users and protects quoted text, code, links and mentions", async t => {
 const store = new SQLiteStore(); t.after(() => store.close());
 await store.ingest(message("user")); await store.ingest(message("bot",bot));
 const renderer = new ReplyRenderer(store);
 assert.equal(await renderer.render("s",`User (${alice}) and assistant (${bot}), <@${alice}>, https://discord.com/channels/s/c/${alice}, 12345678901234567`),`User (Teddio) and assistant (Slopbot), <@${alice}>, https://discord.com/channels/s/c/${alice}, 12345678901234567`);
 const protectedText = `"quoted ${alice}" \`${alice}\` \`\`\`json\n{"user":${alice}}\n\`\`\``;
 assert.equal(await renderer.render("s", protectedText), protectedText);
 assert.equal(await renderer.render("s", alice, true),alice);
 assert.equal(await renderer.render("elsewhere",alice),alice);
});

test("shared profile tools enforce ownership, expose public dumps and retain source attribution", async t => {
 const store = new SQLiteStore(); t.after(() => store.close());
 await store.ingest(message("source"));
 const registry = new ToolRegistry(store,async()=>false); registerProfileTools(registry,store);
 await registry.invoke(message("source"),"profile",{action:"set",field:"real_name",value:"Ted"},"edit","command");
 const result=await registry.invoke(message("source"),"profile",{action:"get"},"get","agent");
 assert.ok(result.includes("Ted")&&result.includes("self-reported"));
 assert.equal(registry.definitions()[0]?.publicResult?.({action:"get"}),true);
 assert.equal(registry.definitions()[0]?.publicResult?.({action:"history"}),false);
 assert.deepEqual(store.profile("s",alice).fields[0]?.sourceIds,["source"]);
});

test("relevant profile fields enter prompts with names and original sources", async t => {
 const store = new SQLiteStore(); t.after(() => store.close()); const llm=new FakeLLM();
 await store.ingest(message("profile-source")); store.editProfile(message("profile-source"),alice,"github","https://github.com/example","github");
 const app=new Application(store,llm,{allowedChannels:[{server:"s",channel:"c"}]},undefined,{profiles:store});
 await app.handle({...message("question"),text:"what do you know about me"});
 const profile=llm.prompts[0]?.inputs.find(item=>item.content.includes('"public_profile"'));
 assert.ok(profile?.content.includes("Teddio")&&profile.content.includes("profile-source"));
});

test("profiles include the mentioned subject of a referenced bot message in a task", async t => {
 const store=new SQLiteStore();t.after(()=>store.close());const llm=new FakeLLM(),rice="12345678901234567";
 await store.ingest({...message("rice",rice),authorName:"Rice Farmer"});
 await store.ingest({...message("profile",bot),text:`Rice Farmer (<@${rice}>) Discord identity`});
 const app=new Application(store,llm,{allowedChannels:[{server:"s",channel:"c"}]},undefined,{profiles:store});
 await app.handle({...message("correction"),text:"his name is Oscar",replyTo:"profile",taskId:"c"});
 assert.ok(llm.prompts[0]?.inputs.some(item=>item.content.includes('"public_profile"')&&item.content.includes(`"user_id":"${rice}"`)));
 assert.ok(llm.prompts[0]?.inputs.at(-1)?.content.includes("About Rice Farmer"));
});
