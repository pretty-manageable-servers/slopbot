import { Application } from "./application.js";
import { FakeLLM } from "./adapters/fake-llm.js";
import { SQLiteStore } from "./adapters/sqlite.js";

const store = new SQLiteStore();
try {
  const app = new Application(store, new FakeLLM(), {
    allowedChannels: [{ server: "local", channel: "general" }],
  });
  const reply = await app.handle({
    id: "1", server: "local", channel: "general", author: "alice", text: "Hello",
  });
  console.log(reply?.text);
} finally {
  store.close();
}
