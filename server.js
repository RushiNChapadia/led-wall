const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server)

const PORT = process.env.PORT || 3000;

// wall configuration ----
const TILE_COUNT = 18
const QUESTION_TEXT = "What is the 'Why' that drives you?";
const PALETTE = ["#00395B", "#00779B", "#FFCB05"]; // Navy, Teal, Yellow


const tiles = Array.from({ length: TILE_COUNT }, () => ({
  name: "",
  region: "",
  question: QUESTION_TEXT,
  answerDataUrl: "",
  color: "",
  updatedAt: 0
}));

function safeTrim(str, maxLen) {
  if (typeof str !== "string") return "";
  const s = str.trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isLikelyPngDataUrl(dataUrl) {
  return typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,");
}

function approxBase64Bytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

function randomPaletteColor() {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

function findRandomEmptyIndex() {
  const empty = [];
  for (let i = 0; i < tiles.length; i++) {
    if (!tiles[i].answerDataUrl) empty.push(i);
  }
  if (empty.length === 0) return -1;
  return empty[Math.floor(Math.random() * empty.length)];
}

function findOldestIndex() {
  let idx = 0;
  let t = tiles[0].updatedAt || 0;
  for (let i = 1; i < tiles.length; i++) {
    const ti = tiles[i].updatedAt || 0;
    if (ti < t) {
      t = ti;
      idx = i;
    }
  }
  return idx;
}

function assignTileIndex() {
  const empty = findRandomEmptyIndex();
  return empty !== -1 ? empty : findOldestIndex();
}

// static hosting

app.use(express.static("public"));

app.get("/health", (req, res) => res.json({ ok: true }));

io.on("connection", (socket) => {
  socket.emit("state:init", { tiles, question: QUESTION_TEXT });

  socket.on("submission:new", (payload) => {
    const name = safeTrim(payload?.name, 40);
    const region = safeTrim(payload?.region, 40);
    const answerDataUrl = payload?.answerDataUrl;

    if (!name) {
      socket.emit("submission:error", { message: "Name is required." });
      return;
    }
    if (!region) {
      socket.emit("submission:error", { message: "Region is required." });
      return;
    }
    if (!isLikelyPngDataUrl(answerDataUrl)) {
      socket.emit("submission:error", { message: "Answer must be a handwritten PNG drawing." });
      return;
    }

    // Limit payload size for event Wi-Fi stability
    const bytes = approxBase64Bytes(answerDataUrl);
    const MAX_BYTES = 900_000; // ~0.9MB
    if (bytes > MAX_BYTES) {
      socket.emit("submission:error", {
        message: "Drawing too large. Please write smaller or clear and try again."
      });
      return;
    }

    const idx = assignTileIndex();
    const now = Date.now();

    tiles[idx] = {
      name,
      region,
      question: QUESTION_TEXT,
      answerDataUrl,
      color: randomPaletteColor(),
      updatedAt: now
    };

    io.emit("tile:update", { index: idx, tile: tiles[idx] });
    socket.emit("submission:ok", { placedAt: idx + 1 }); // 1-based for UI
  });
  // Optional admin clear (call from browser console if needed)
  const ADMIN_KEY = process.env.ADMIN_KEY || "tarsus123"; // change this

io.on("connection", (socket) => {
  socket.emit("state:init", { tiles, question: QUESTION_TEXT });

  socket.on("submission:new", (payload) => {
    // ... keep your existing submission logic as-is
  });

  // ✅ Secured admin reset
  socket.on("admin:clearAll", (payload) => {
    const key = (payload?.key || "").trim();

    if (key !== ADMIN_KEY) {
      socket.emit("admin:error", { message: "Invalid admin key." });
      return;
    }

    for (let i = 0; i < tiles.length; i++) {
      tiles[i] = {
        name: "",
        region: "",
        question: QUESTION_TEXT,
        answerDataUrl: "",
        color: "",
        updatedAt: 0
      };
    }

    io.emit("state:init", { tiles, question: QUESTION_TEXT });
    socket.emit("admin:ok", { message: "Wall cleared successfully." });
  });
});
});

server.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
  console.log(`🧱 Wall : http://localhost:${PORT}/wall.html`);
  console.log(`✍️ iPad : http://localhost:${PORT}/ipad.html`);
});