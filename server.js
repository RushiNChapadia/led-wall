const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { Pool } = require("pg");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const ExcelJS = require("exceljs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const TILE_COUNT = 18;
const QUESTION_TEXT = "What is the 'Why' that drives you?";

// ------------------ Render Postgres ------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

// ------------------ Cloudflare R2 (S3 compatible) ------------------
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");

// ------------------ In-memory wall state ------------------
const tiles = Array.from({ length: TILE_COUNT }, () => ({
  name: "",
  region: "",
  question: QUESTION_TEXT,
  answerImageUrl: "",
  updatedAt: 0,
}));

// ------------------ Helpers ------------------
function safeTrim(str, maxLen) {
  if (typeof str !== "string") return "";
  const s = str.trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isLikelyPngDataUrl(dataUrl) {
  return typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,");
}

function base64ToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(b64, "base64");
}

function assignTileIndex() {
  // random empty else oldest
  const empty = [];
  for (let i = 0; i < tiles.length; i++) {
    if (!tiles[i].answerImageUrl) empty.push(i);
  }
  if (empty.length > 0) return empty[Math.floor(Math.random() * empty.length)];

  let oldestIdx = 0;
  let oldestTime = tiles[0].updatedAt || 0;
  for (let i = 1; i < tiles.length; i++) {
    const t = tiles[i].updatedAt || 0;
    if (t < oldestTime) {
      oldestTime = t;
      oldestIdx = i;
    }
  }
  return oldestIdx;
}

function requireAdmin(req, res) {
  const key = req.query.key || "";
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

// ------------------ DB init + restore wall ------------------
async function initDbAndRestoreWall() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      question TEXT NOT NULL,
      tile_index INT NOT NULL,
      image_key TEXT NOT NULL,
      image_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Restore latest submission per tile_index to refill current wall state
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (tile_index)
      tile_index, name, region, question, image_key, image_url, created_at
    FROM submissions
    ORDER BY tile_index, created_at DESC;
  `);

  for (let i = 0; i < TILE_COUNT; i++) {
    tiles[i] = { name: "", region: "", question: QUESTION_TEXT, answerImageUrl: "", updatedAt: 0 };
  }

  for (const r of rows) {
    const idx = Number(r.tile_index);
    if (Number.isInteger(idx) && idx >= 0 && idx < TILE_COUNT) {
      tiles[idx] = {
        name: r.name,
        region: r.region,
        question: r.question || QUESTION_TEXT,
        answerImageUrl: r.image_url,
        updatedAt: new Date(r.created_at).getTime(),
      };
    }
  }

  console.log("✅ DB ready + wall state restored.");
}

// ------------------ Static hosting ------------------
app.use(express.static("public"));
// Serve images via same-origin proxy to avoid cross-origin blocking
app.get("/img/*", async (req, res) => {
  try {
    const key = req.params[0]; // everything after /img/
    if (!key) return res.status(400).send("Missing key");
    if (!R2_BUCKET) return res.status(500).send("Bucket not configured");

    const out = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key
    }));

    // Set headers
    res.setHeader("Content-Type", out.ContentType || "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    // Stream body
    out.Body.pipe(res);
  } catch (e) {
    console.error("IMG proxy error:", e);
    res.status(404).send("Not found");
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ------------------ Export endpoints ------------------
app.get("/admin/export.csv", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { rows } = await pool.query(`
    SELECT id, name, region, question, tile_index, image_url, created_at
    FROM submissions
    ORDER BY created_at ASC;
  `);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="tarsus-submissions.csv"');

  const header = ["id","name","region","question","tile_index","image_url","created_at"];
  res.write(header.join(",") + "\n");

  for (const r of rows) {
    const values = header.map((k) => {
      const v = r[k];
      const s = (v === null || v === undefined) ? "" : String(v);
      const escaped = s.replace(/"/g, '""');
      return `"${escaped}"`;
    });
    res.write(values.join(",") + "\n");
  }
  res.end();
});

app.get("/admin/export.xlsx", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { rows } = await pool.query(`
    SELECT id, name, region, question, tile_index, image_url, created_at
    FROM submissions
    ORDER BY created_at ASC;
  `);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Submissions");

  ws.columns = [
    { header: "id", key: "id", width: 36 },
    { header: "name", key: "name", width: 22 },
    { header: "region", key: "region", width: 18 },
    { header: "question", key: "question", width: 50 },
    { header: "tile_index", key: "tile_index", width: 10 },
    { header: "image_url", key: "image_url", width: 60 },
    { header: "created_at", key: "created_at", width: 24 },
  ];

  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="tarsus-submissions.xlsx"');

  await wb.xlsx.write(res);
  res.end();
});

// ------------------ Socket.IO ------------------
io.on("connection", (socket) => {
  socket.emit("state:init", {
    question: QUESTION_TEXT,
    tiles: tiles.map(t => ({
      name: t.name,
      region: t.region,
      question: t.question,
      answerImageUrl: t.answerImageUrl,
      updatedAt: t.updatedAt
    })),
  });

  socket.on("submission:new", async (payload) => {
    try {
      const name = safeTrim(payload?.name, 40);
      const region = safeTrim(payload?.region, 40);
      const answerDataUrl = payload?.answerDataUrl;

      if (!name) return socket.emit("submission:error", { message: "Name is required." });
      if (!region) return socket.emit("submission:error", { message: "Region is required." });
      if (!isLikelyPngDataUrl(answerDataUrl)) {
        return socket.emit("submission:error", { message: "Answer must be a PNG drawing." });
      }
      if (!R2_BUCKET || !R2_PUBLIC_BASE_URL || !process.env.R2_ENDPOINT) {
        return socket.emit("submission:error", { message: "R2 is not configured on server." });
      }

      const buffer = base64ToBuffer(answerDataUrl);

      // keep uploads reasonable
      const MAX_BYTES = 900_000;
      if (buffer.length > MAX_BYTES) {
        return socket.emit("submission:error", { message: "Drawing too large. Please write smaller or clear and try again." });
      }

      const idx = assignTileIndex();
      const id = uuidv4();
      const imageKey = `submissions/${id}.png`;

      // Upload to R2
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: imageKey,
        Body: buffer,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000, immutable",
      }));

      const imageUrl = `${R2_PUBLIC_BASE_URL}/${imageKey}`;

      const wallImageUrl = `/img/${imageKey}`;

      // Save to DB (history)
      const insert = await pool.query(
        `INSERT INTO submissions (id, name, region, question, tile_index, image_key, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING created_at;`,
        [id, name, region, QUESTION_TEXT, idx, imageKey, imageUrl]
      );

      const createdAtMs = new Date(insert.rows[0].created_at).getTime();

      // Update current wall state
      tiles[idx] = {
        name,
        region,
        question: QUESTION_TEXT,
        answerImageUrl: wallImageUrl,
        updatedAt: createdAtMs,
      };

      io.emit("tile:update", {
        index: idx,
        tile: {
          name,
          region,
          question: QUESTION_TEXT,
          answerImageUrl: wallImageUrl,
          updatedAt: createdAtMs,
        }
      });

      socket.emit("submission:ok", { placedAt: idx + 1 });
    } catch (err) {
      console.error(err);
      socket.emit("submission:error", { message: "Server error. Try again." });
    }
  });

  // Reset only clears wall display, history stays
  socket.on("admin:clearAll", () => {
    for (let i = 0; i < TILE_COUNT; i++) {
      tiles[i] = { name: "", region: "", question: QUESTION_TEXT, answerImageUrl: "", updatedAt: 0 };
    }
    io.emit("state:init", {
      question: QUESTION_TEXT,
      tiles: tiles.map(t => ({
        name: t.name,
        region: t.region,
        question: t.question,
        answerImageUrl: t.answerImageUrl,
        updatedAt: t.updatedAt
      })),
    });
  });
});

// ------------------ Start ------------------
(async () => {
  await initDbAndRestoreWall();
  server.listen(PORT, () => console.log(`✅ Server running on :${PORT}`));
})();


// const express = require("express");
// const http = require("http");
// const { Server } = require("socket.io");

// const app = express();
// const server = http.createServer(app);
// const io = new Server(server)

// const PORT = process.env.PORT || 3000;

// // wall configuration ----
// const TILE_COUNT = 18
// const QUESTION_TEXT = "What is the 'Why' that drives you?";
// const PALETTE = ["#00395B", "#00779B", "#FFCB05"]; // Navy, Teal, Yellow


// const tiles = Array.from({ length: TILE_COUNT }, () => ({
//   name: "",
//   region: "",
//   question: QUESTION_TEXT,
//   answerDataUrl: "",
//   color: "",
//   updatedAt: 0
// }));

// //DB testing
// const { Pool } = require("pg");

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: process.env.DATABASE_URL?.includes("render.com")
//     ? { rejectUnauthorized: false }
//     : undefined,
// });

// app.get("/db-test", async (req, res) => {
//   try {
//     const r = await pool.query("SELECT NOW() as now");
//     res.json({ ok: true, now: r.rows[0].now });
//   } catch (e) {
//     res.status(500).json({ ok: false, error: String(e) });
//   }
// });

// function safeTrim(str, maxLen) {
//   if (typeof str !== "string") return "";
//   const s = str.trim();
//   return s.length > maxLen ? s.slice(0, maxLen) : s;
// }

// function isLikelyPngDataUrl(dataUrl) {
//   return typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,");
// }

// function approxBase64Bytes(dataUrl) {
//   const comma = dataUrl.indexOf(",");
//   const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
//   return Math.floor((b64.length * 3) / 4);
// }

// function randomPaletteColor() {
//   return PALETTE[Math.floor(Math.random() * PALETTE.length)];
// }

// function findRandomEmptyIndex() {
//   const empty = [];
//   for (let i = 0; i < tiles.length; i++) {
//     if (!tiles[i].answerDataUrl) empty.push(i);
//   }
//   if (empty.length === 0) return -1;
//   return empty[Math.floor(Math.random() * empty.length)];
// }

// function findOldestIndex() {
//   let idx = 0;
//   let t = tiles[0].updatedAt || 0;
//   for (let i = 1; i < tiles.length; i++) {
//     const ti = tiles[i].updatedAt || 0;
//     if (ti < t) {
//       t = ti;
//       idx = i;
//     }
//   }
//   return idx;
// }

// function assignTileIndex() {
//   const empty = findRandomEmptyIndex();
//   return empty !== -1 ? empty : findOldestIndex();
// }

// // static hosting

// app.use(express.static("public"));

// app.get("/health", (req, res) => res.json({ ok: true }));

// io.on("connection", (socket) => {
//   socket.emit("state:init", { tiles, question: QUESTION_TEXT });

//   socket.on("submission:new", (payload) => {
//     const name = safeTrim(payload?.name, 40);
//     const region = safeTrim(payload?.region, 40);
//     const answerDataUrl = payload?.answerDataUrl;

//     if (!name) {
//       socket.emit("submission:error", { message: "Name is required." });
//       return;
//     }
//     if (!region) {
//       socket.emit("submission:error", { message: "Region is required." });
//       return;
//     }
//     if (!isLikelyPngDataUrl(answerDataUrl)) {
//       socket.emit("submission:error", { message: "Answer must be a handwritten PNG drawing." });
//       return;
//     }

//     // Limit payload size for event Wi-Fi stability
//     const bytes = approxBase64Bytes(answerDataUrl);
//     const MAX_BYTES = 900_000; // ~0.9MB
//     if (bytes > MAX_BYTES) {
//       socket.emit("submission:error", {
//         message: "Drawing too large. Please write smaller or clear and try again."
//       });
//       return;
//     }

//     const idx = assignTileIndex();
//     const now = Date.now();

//     tiles[idx] = {
//       name,
//       region,
//       question: QUESTION_TEXT,
//       answerDataUrl,
//       color: randomPaletteColor(),
//       updatedAt: now
//     };

//     io.emit("tile:update", { index: idx, tile: tiles[idx] });
//     socket.emit("submission:ok", { placedAt: idx + 1 }); // 1-based for UI
//   });
//   // Optional admin clear (call from browser console if needed)
//   const ADMIN_KEY = process.env.ADMIN_KEY || "tarsus123"; // change this

// io.on("connection", (socket) => {
//   socket.emit("state:init", { tiles, question: QUESTION_TEXT });

//   socket.on("submission:new", (payload) => {
//     // ... keep your existing submission logic as-is
//   });

//   // ✅ Secured admin reset
//   socket.on("admin:clearAll", (payload) => {
//     const key = (payload?.key || "").trim();

//     if (key !== ADMIN_KEY) {
//       socket.emit("admin:error", { message: "Invalid admin key." });
//       return;
//     }

//     for (let i = 0; i < tiles.length; i++) {
//       tiles[i] = {
//         name: "",
//         region: "",
//         question: QUESTION_TEXT,
//         answerDataUrl: "",
//         color: "",
//         updatedAt: 0
//       };
//     }

//     io.emit("state:init", { tiles, question: QUESTION_TEXT });
//     socket.emit("admin:ok", { message: "Wall cleared successfully." });
//   });
// });
// });

// server.listen(PORT, () => {
//   console.log(`✅ Server: http://localhost:${PORT}`);
//   console.log(`🧱 Wall : http://localhost:${PORT}/wall.html`);
//   console.log(`✍️ iPad : http://localhost:${PORT}/ipad.html`);
// });