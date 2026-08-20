// Local stand-in for the DeepSeek (chat) and Gemini (image) APIs, used by
// scripts/e2e.mjs to validate the full agent+generation loop without real
// credentials. The real adapters hit the same code paths — only base URLs
// and keys differ.
import http from "node:http";

// 4x4 red PNG.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8z4APMOGVHTGyAF+jAR9G6DEPAAAAAElFTkSuQmCC";

const SCENE_PLAN = {
  summary: "Compose a three-panel scene with Akari arriving late to class.",
  steps: [
    { tool: "set_page_layout", args: { layout: "three-vertical" }, reason: "three beats" },
    { tool: "generate_background", args: { description: "school classroom, morning light", name: "Classroom" } },
    { tool: "create_character", args: { name: "Akari", description: "high school girl, short black hair" } },
    { tool: "generate_character_asset", args: { characterName: "Akari", kind: "reference" } },
    { tool: "place_asset", args: { panel: 1, category: "background", cropMode: "fill" } },
    { tool: "place_asset", args: { panel: 1, characterName: "Akari" } },
    { tool: "place_asset", args: { panel: 3, characterName: "Akari", cropMode: "upper-body" } },
    {
      tool: "reshape_panel",
      args: {
        panel: 1,
        points: [
          { x: 0.03, y: 0.03 },
          { x: 0.97, y: 0.03 },
          { x: 0.8, y: 0.34 },
          { x: 0.03, y: 0.3 },
        ],
      },
      reason: "diagonal cut for motion",
    },
    { tool: "add_speech_bubble", args: { panel: 1, bubbleType: "speech", text: "I'm late!!", position: "top-right" } },
    { tool: "add_effect", args: { panel: 1, effectKind: "speed-lines" } },
  ],
};

// Selection-contextual prompt: "make her cry" — targets the selected instance.
const CRY_PLAN = {
  summary: "Give the selected Akari a crying expression.",
  steps: [{ tool: "set_character_slot", args: { expression: "crying" } }],
};

function planFor(body) {
  const userText = body?.messages?.find((m) => m.role === "user")?.content ?? "";
  return /cry/i.test(userText) ? CRY_PLAN : SCENE_PLAN;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    console.log(`${req.method} ${req.url}`);
    if (req.url === "/models") {
      // OpenAI-compatible model listing (used by Test Connection + discovery).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-chat" }, { id: "fake-chat-2" }] }));
    } else if (req.url === "/chat/completions") {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(planFor(parsed)) } }] }));
    } else if (req.url?.includes(":generateContent")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG_B64 } }] } }],
        }),
      );
    } else if (req.url?.startsWith("/v1beta/models/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "models/fake" }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
});

server.listen(4545, () => console.log("fake providers on :4545"));
