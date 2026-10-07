#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { fork, spawn } = require("child_process");
const { Client } = require("discord.js-selfbot-v13");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

const PREFIX = "h";
const OWNER_ID = "888766767814553620";
const MUSIC_EXTS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"];
const MUSIC_DIR = path.resolve("./");

function readLines(file) {
  try {
    return fs.readFileSync(path.resolve(file), "utf8")
     .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

const clients = new Map();

if (!process.env.TOKEN) {
  const tokenFile = "tokens.txt";
  if (!fs.existsSync(tokenFile)) {
    console.log("khong tim thay tokens.txt");
    process.exit(1);
  }
  const tokens = readLines(tokenFile).filter(t => t.length > 50);
  if (tokens.length === 0) {
    console.log("tokens.txt rong");
    process.exit(1);
  }
  console.log(`Chu bot: ${OWNER_ID}`);
  console.log(`bat dau chay ${tokens.length} token...`);
  tokens.forEach((tok, i) => {
    setTimeout(() => {
      fork(__filename, [], { env: {...process.env, TOKEN: tok, DATOKEN: String(i)}, stdio: "inherit" });
    }, i * 5000);
  });
  console.warn("Warning: selfbot vi pham TOS cua Discord, co the bi khoa tai khoan.\n");
  return;
}

const TOKEN = process.env.TOKEN;
const SHORT = TOKEN.slice(0, 6);
const DATOKEN = parseInt(process.env.TOKEN?? "#0", 10);

function isVoiceChan(chan) {
  if (!chan) return false;
  return chan.type === "GUILD_VOICE" || chan.type === 2 || typeof chan.join === "function";
}

let volume = 1.0, boost = 1.0, bass = 0, noEffect = false;
let connection = null, player = null, currentTrack = null, ffmpegProc = null;
let lastStoppedTrack = null;
let isMuted = false;
let isMicMuted = false;
let isPlaying = false;
let isPaused = false;

function killFFmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.kill("SIGKILL"); } catch { }
    ffmpegProc = null;
  }
}

function createFFmpegResource(filePath, useEcho = false) {
  killFFmpeg();
  const volMul = Math.max(0.0001, Math.min(volume * boost, 1e15));
  const filters = [];
  if (noEffect) filters.push("anull");
  else {
    filters.push(`volume=${volMul}`);
    if (bass!== 0) filters.push(`bass=g=${Math.max(-500, Math.min(bass, 500))}`);
    if (useEcho) filters.push("aecho=0.8:0.88:60:0.4");
  }
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-re", "-i", filePath,
    "-filter:a", filters.join(","),
    "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpegProc = proc;
  proc.on("error", e => console.log(`ffmpeg error: ${e.message}`));
  proc.stderr.on("data", d => {
    const m = d.toString().trim();
    if (m &&!m.includes("pixel format")) console.log(`[ffmpeg] ${m}`);
  });
  const res = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
  res.playStream.on("close", killFFmpeg);
  return res;
}

async function ensureConn(client, chanId) {
  const chan = await client.channels.fetch(chanId).catch(() => null);
  if (!chan ||!isVoiceChan(chan)) return null;
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = joinVoiceChannel({
      channelId: chan.id,
      guildId: chan.guild?.id,
      adapterCreator: chan.guild?.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: isMuted
    });
    connection.on("stateChange", (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Destroyed) connection = null;
    });
  }
  if (connection.state.status!== VoiceConnectionStatus.Ready) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 10000);
    } catch {
      try { connection.destroy(); } catch { }
      connection = null;
      return null;
    }
  }
  return { conn: connection, chan };
}

function playNow() {
  if (!player || !currentTrack || !fs.existsSync(currentTrack.filePath)) {
    isPlaying = false;
    return;
  }
  if (isPaused) return;
  try {
    player.play(createFFmpegResource(currentTrack.filePath, currentTrack.useEcho || false));
    isPlaying = true;
  } catch { 
    isPlaying = false;
  }
}

function pauseMusic() {
  if (player && isPlaying) {
    try {
      player.pause();
      isPaused = true;
      isPlaying = false;
      return true;
    } catch (e) {
      console.log(`[pause] error: ${e.message}`);
      return false;
    }
  }
  return false;
}

function resumeMusic() {
  if (player && isPaused) {
    try {
      player.unpause();
      isPaused = false;
      isPlaying = true;
      return true;
    } catch (e) {
      console.log(`[resume] error: ${e.message}`);
      return false;
    }
  }
  return false;
}

async function playMusic(client, filePath, chanId, useEcho = false) {
  const ctx = await ensureConn(client, chanId);
  if (!ctx) {
    console.log(`[${client.user?.tag}] khong tim thay voice ${chanId}`);
    return;
  }
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on(AudioPlayerStatus.Idle, () => {
      isPlaying = false;
      isPaused = false;
      if (currentTrack && !isPaused) {
        playNow();
      }
    });
    player.on(AudioPlayerStatus.Playing, () => {
      isPlaying = true;
      isPaused = false;
    });
    player.on(AudioPlayerStatus.Paused, () => {
      isPlaying = false;
      isPaused = true;
    });
    player.on("error", e => {
      console.log(`[${client.user?.tag}] player error: ${e.message}`);
      isPlaying = false;
      isPaused = false;
      try { connection?.destroy(); } catch { }
      connection = null; player = null; killFFmpeg();
    });
  }
  try { ctx.conn.subscribe(player); } catch { }
  if (!fs.existsSync(filePath)) {
    console.log(`[${client.user?.tag}] khong tim thay file: ${filePath}`);
    return;
  }
  currentTrack = { filePath, chanId, useEcho };
  isPaused = false;
  playNow();
  console.log(`[${client.user?.tag}] play ${path.basename(filePath)} @ ${chanId} | vol ${Math.round(volume * 100)}% boost ${Math.round(boost * 100)}% bass ${bass}dB echo ${useEcho? "ON" : "OFF"} effect ${noEffect? "OFF" : "ON"} mute ${isMuted? "ON" : "OFF"} mic ${isMicMuted? "OFF" : "ON"}`);
}

function reloadTrack() { 
  if (!isPaused) {
    playNow(); 
  }
}

function listMusicFiles() {
  let files = [];
  try { files = fs.readdirSync(MUSIC_DIR); } catch { }
  return files.filter(f => MUSIC_EXTS.some(ext => f.toLowerCase().endsWith(ext))).sort((a, b) => a.localeCompare(b));
}

function resolveTrack(arg) {
  const musicFiles = listMusicFiles();
  const idx = parseInt(arg, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= musicFiles.length) return musicFiles[idx - 1];
  const direct = path.resolve(arg);
  if (fs.existsSync(direct)) return path.basename(direct);
  const candidates = MUSIC_EXTS.map(ext => (arg.toLowerCase().endsWith(ext)? arg : arg + ext));
  for (const c of candidates) {
    const p = path.join(MUSIC_DIR, path.basename(c));
    if (fs.existsSync(p)) return path.basename(c);
    if (musicFiles.includes(path.basename(c))) return path.basename(c);
  }
  return null;
}

function stopMusic() {
  if (currentTrack) lastStoppedTrack = {...currentTrack };
  if (player) { player.stop(true); player = null; }
  if (connection && connection.state?.status!== VoiceConnectionStatus.Destroyed) {
    try { connection.destroy(); } catch {}
    connection = null;
  }
  killFFmpeg();
  const trackName = lastStoppedTrack? path.basename(lastStoppedTrack.filePath) : "Unknown";
  currentTrack = null;
  isMuted = false;
  isMicMuted = false;
  isPlaying = false;
  isPaused = false;
  return trackName;
}

function toggleMute() {
  isMuted = !isMuted;
  if (connection) {
    try { connection.setSelfMute(isMuted); } catch { }
  }
  return isMuted;
}

function toggleMic() {
  isMicMuted = !isMicMuted;
  if (connection) {
    try { connection.setSelfMute(isMicMuted); } catch { }
  }
  return isMicMuted;
}

function getStatus() {
  return {
    isMuted,
    isMicMuted,
    isPlaying,
    isPaused,
    currentTrack: currentTrack ? path.basename(currentTrack.filePath) : null,
    volume: Math.round(volume * 100),
    boost: Math.round(boost * 100),
    bass
  };
}

const client = new Client();

client.on("ready", () => {
  console.log(`online: ${client.user.tag} [${SHORT}] ${DATOKEN}`);
  clients.set(TOKEN, client);
});

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.content ||!msg.content.startsWith(PREFIX)) return;
    const parts = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (parts.shift() || "").toLowerCase();
    const isOwner = msg.author?.id === OWNER_ID;

    if (!isOwner) {
      if (["moloa", "tatloa", "momic", "tatmic", "pause", "tamdung", "resume", "tieptuc", "xa", "exit", "volume", "boost", "bass", "upload", "listnhac"].includes(cmd)) {
        return msg.channel.send("❌ Bạn không có quyền sử dụng lệnh này.");
      }
      return;
    }

    if (cmd === "moloa") {
      if (!connection) {
        await msg.channel.send("❌ Bot chưa kết nối vào voice channel.");
        return;
      }
      if (!isMuted) {
        await msg.channel.send("ℹ️ Loa đã được mở sẵn.");
        return;
      }
      toggleMute();
      await msg.channel.send(`🔊 Token [${SHORT}] đã **MỞ LOA** thành công!`);
      console.log(`[${client.user?.tag}] Mở loa`);
      return;
    }

    if (cmd === "tatloa") {
      if (!connection) {
        await msg.channel.send("❌ Bot chưa kết nối vào voice channel.");
        return;
      }
      if (isMuted) {
        await msg.channel.send("ℹ️ Loa đã được tắt sẵn.");
        return;
      }
      toggleMute();
      await msg.channel.send(`🔇 Token [${SHORT}] đã **TẮT LOA** thành công!`);
      console.log(`[${client.user?.tag}] Tắt loa`);
      return;
    }

    if (cmd === "momic") {
      if (!connection) {
        await msg.channel.send("❌ Bot chưa kết nối vào voice channel.");
        return;
      }
      if (!isMicMuted) {
        await msg.channel.send("ℹ️ Mic đã được mở sẵn.");
        return;
      }
      toggleMic();
      await msg.channel.send(`🎤 Token [${SHORT}] đã **MỞ MIC** thành công!`);
      console.log(`[${client.user?.tag}] Mở mic`);
      return;
    }

    if (cmd === "tatmic") {
      if (!connection) {
        await msg.channel.send("❌ Bot chưa kết nối vào voice channel.");
        return;
      }
      if (isMicMuted) {
        await msg.channel.send("ℹ️ Mic đã được tắt sẵn.");
        return;
      }
      toggleMic();
      await msg.channel.send(`🔇 Token [${SHORT}] đã **TẮT MIC** thành công!`);
      console.log(`[${client.user?.tag}] Tắt mic`);
      return;
    }

    if (cmd === "pause" || cmd === "tamdung") {
      if (!isPlaying) {
        await msg.channel.send("❌ Không có nhạc đang phát để tạm dừng.");
        return;
      }
      if (pauseMusic()) {
        await msg.channel.send(`⏸️ Token [${SHORT}] đã **TẠM DỪNG** nhạc. Dùng \`!resume\` hoặc \`!tieptuc\` để tiếp tục.`);
      } else {
        await msg.channel.send("❌ Lỗi khi tạm dừng nhạc.");
      }
      return;
    }

    if (cmd === "resume" || cmd === "tieptuc") {
      if (!isPaused) {
        await msg.channel.send("ℹ️ Nhạc đang phát hoặc chưa được tạm dừng.");
        return;
      }
      if (resumeMusic()) {
        await msg.channel.send(`▶️ Token [${SHORT}] đã **TIẾP TỤC** phát nhạc.`);
      } else {
        await msg.channel.send("❌ Lỗi khi tiếp tục phát nhạc.");
      }
      return;
    }

    if (cmd === "xa") {
      const arg1 = parts[0], chanId = parts[1];
      if (!arg1 ||!chanId) {
        await msg.channel.send("Cú pháp: `!xa <số|file> <voice_id> [echo]`");
        return;
      }
      const useEcho = parts[2] && parts[2].toLowerCase() === "echo";
      const fileName = resolveTrack(arg1);
      if (!fileName) {
        await msg.channel.send("Không tìm thấy file. Dùng `!listnhac` để xem số thứ tự hoặc nhập đúng tên file.");
        return;
      }
      const fp = path.join(MUSIC_DIR, fileName);
      if (!fs.existsSync(fp)) {
        await msg.reply(`Không tìm thấy file: ${fileName}`);
        return;
      }
      await playMusic(client, fp, chanId, useEcho);

      let duration = "N/A";
      try {
        const probe = spawn("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          fp
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const raw = await new Promise((resolve) => {
          let out = "";
          probe.stdout.on("data", d => out += d.toString());
          probe.on("close", () => resolve(out.trim()));
        });
        const secs = parseFloat(raw);
        if (!isNaN(secs)) {
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = Math.floor(secs % 60);
          duration = h > 0
           ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
            : `${m}:${String(s).padStart(2, "0")}`;
        }
      } catch { }

      const status = getStatus();
      await msg.channel.send(
        `# > 🎧 **MUSIC** \n` +
        ` **• Song:** \`${path.basename(fp)}\`\n` +
        ` **• Thời lượng:** \`${duration}\`\n` +
        ` **• Volume:** \`${status.volume}%\`\n` +
        ` **• Boost:** \`${status.boost}%\`\n` +
        ` **• Bass:** \`${status.bass} dB\`\n` +
        ` **• Echo:** \`${useEcho? "ON" : "OFF"}\`\n` +
        ` **• Loa:** \`${status.isMuted? "🔇 TẮT" : "🔊 MỞ"}\`\n` +
        ` **• Mic:** \`${status.isMicMuted? "🔇 TẮT" : "🎤 MỞ"}\`\n` +
        ` **• Trạng thái:** \`${status.isPlaying ? "▶️ ĐANG PHÁT" : status.isPaused ? "⏸️ TẠM DỪNG" : "⏹️ DỪNG"}\`\n` +
        ` **• __Xiang Cute__:** `
      );
      return;
    }

    if (cmd === "exit") {
      if (!player && !connection) { 
        await msg.channel.send("Khong co nhac nao dang phat de dung."); 
        return; 
      }
      const trackName = stopMusic();
      await msg.channel.send(`⛔ Token [${SHORT}] xị tha cho mày đó: **${trackName}**`);
      return;
    }

    if (cmd === "volume") {
      const v = Number(parts[0]);
      if (isNaN(v) || v < 1 || v > 100000000000) {
        await msg.channel.send("volume 1-100000000000%");
        return;
      }
      volume = v / 100;
      reloadTrack();
      await msg.channel.send(`🔊 Token [${SHORT}] da chinh volume thanh **${v}%** `);
      return;
    }

    if (cmd === "boost") {
      const b = Number(parts[0]);
      if (isNaN(b) || b < 1 || b > 100000000000) {
        await msg.channel.send("boost 1-100000000000%");
        return;
      }
      boost = b / 100;
      reloadTrack();
      await msg.channel.send(`🚀 Token [${SHORT}] Boost nhac thanh **${b}%** `);
      return;
    }

    if (cmd === "bass") {
      const bs = parseInt(parts[0], 10);
      if (isNaN(bs) || bs < -500 || bs > 500) {
        await msg.channel.send("bass -500 den 500");
        return;
      }
      bass = bs;
      reloadTrack();
      await msg.channel.send(`🎚️ Token [${SHORT}] chinh bass thanh **${bs} dB** `);
      return;
    }

    if (cmd === "upload") {
      const attachments = [];
      if (msg.attachments) {
        const vals = msg.attachments instanceof Map
         ? Array.from(msg.attachments.values())
          : (typeof msg.attachments.values === "function"? Array.from(msg.attachments.values()) : []);
        attachments.push(...vals);
      }
      const refId = msg.reference?.messageId?? msg.reference?.message_id?? null;
      if (refId) {
        try {
          const replied = await msg.channel.messages.fetch(refId);
          if (replied && replied.attachments) {
            const vals = replied.attachments instanceof Map
             ? Array.from(replied.attachments.values())
              : (typeof replied.attachments.values === "function"? Array.from(replied.attachments.values()) : []);
            attachments.push(...vals);
          }
        } catch (e) {
          console.log(`[upload] fetch replied msg error: ${e.message}`);
        }
      }

      console.log(`[upload] found ${attachments.length} attachment(s)`);

      if (attachments.length === 0) {
        return msg.channel.send(
          "Khong tim thay file dinh kem.\n" +
          "- Gui `!upload` kem file dinh kem\n" +
          "- Hoac reply vao tin nhan co file roi go `!upload`"
        );
      }

      const allowedExts = [".txt", ".mp3", ".wav", ".ogg", ".flac", ".m4a"];
      const picked = attachments.filter(a => allowedExts.includes(path.extname(a.name || "").toLowerCase()));
      if (picked.length === 0) return msg.channel.send("Chi chap nhan cac file: txt, mp3, wav, ogg, flac, m4a");

      const results = { ok: [], fail: [] };
      await Promise.all(picked.map(async (attachment) => {
        const ext = path.extname(attachment.name || "").toLowerCase();
        const baseRaw = path.basename(attachment.name || "file", ext) || "track";
        const base = baseRaw.replace(/[^\w.\- ]/g, "_").trim() || "track";
        let finalName = `${base}${ext}`;
        let finalPath = path.join(MUSIC_DIR, finalName);
        let i = 1;
        while (fs.existsSync(finalPath)) {
          finalName = `${base} (${i})${ext}`;
          finalPath = path.join(MUSIC_DIR, finalName);
          i++;
        }
        try {
          const response = await fetch(attachment.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          fs.writeFileSync(finalPath, Buffer.from(buffer));
          results.ok.push(finalName);
        } catch (e) {
          results.fail.push(`${attachment.name || "unknown"} (${e.message || e})`);
        }
      }));

      const okList = results.ok.length? results.ok.map(n => `- ${n}`).join("\n") : "(khong co)";
      const failList = results.fail.length? results.fail.map(n => `- ${n}`).join("\n") : "(khong co)";
      return msg.channel.send(
        `# > da upload xong ${results.ok.length}/${picked.length} file\n **Thanh cong file:** \n${okList}\n **That bai file:** \n${failList}`
      );
    }
    
    if (cmd === "listnhac") {
      try {
        const musicFiles = listMusicFiles();
        if (musicFiles.length === 0) {
          await msg.channel.send("Khong tim thay bat ky tep nhac nao trong thu muc.");
          return;
        }
        const listHeader = " **Danh Sach Cac Bai Nhac:** \n";
        const fileListContent = musicFiles.map((file, index) => `${index + 1} :: ${file}`).join("\n");
        const fullMessage = listHeader + "```" + fileListContent + "```";
        if (fullMessage.length > 2000) {
          const maxContentLength = 2000 - listHeader.length - 10;
          let currentPos = 0, chunkIndex = 0;
          while (currentPos < fileListContent.length) {
            let chunk = fileListContent.substring(currentPos, currentPos + maxContentLength);
            let splitIndex = chunk.lastIndexOf('\n');
            if (splitIndex === -1 || currentPos + maxContentLength >= fileListContent.length) splitIndex = chunk.length;
            const contentChunk = chunk.substring(0, splitIndex);
            const partHeader = chunkIndex === 0 ? listHeader : `(Tiep theo) ${listHeader}`;
            await msg.channel.send(`${partHeader} (Phan ${++chunkIndex}):\n\`\`\`\n${contentChunk}\n\`\`\``);
            currentPos += splitIndex + 1;
          }
        } else {
          await msg.channel.send(fullMessage);
        }
      } catch (error) {
        console.error("Loi khi liet ke nhac:", error);
        await msg.channel.send("Da xay ra loi khi liet ke danh sach nhac.");
      }
      return;
    }

  } catch (e) {
    console.log(`[messageCreate] error: ${e.message}`);
  }
});

client.on("error", e => console.log(`client error: ${e.message}`));
client.login(TOKEN).catch(e => {
  console.log(`login fail: ${e.message}`);
  process.exit(1);
});