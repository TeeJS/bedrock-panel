'use strict';

// Known apps: installed-name pattern -> GitHub repo. Used by "Scan this PC" to suggest
// apps the machine already has that git-updater can manage. The name matched against is
// whatever the platform's inventory calls the app — the uninstall-registry DisplayName on
// Windows, the .app bundle name on macOS, the package name on Linux (see src/detect.js).
//
// `platforms` limits an entry to the OSes its upstream actually ships for; omitted means
// all of them. It is only worth setting for apps that exist on ONE platform, where a match
// elsewhere could only ever be a false positive.
//
// `match` is a regex over the human-facing name, used on Windows and macOS.
// `linux` is a list of EXACT identifiers, and Linux uses nothing else — see
// findInstalled() below for why a regex is the wrong tool against a package namespace.
// An entry with no `linux` list is simply not offered on Linux. That is the safe
// direction: a missing row costs the user a manual add, a wrong row offers them their
// screen reader as an updatable app.
//
// Patterns follow ninite-helper's Update-NiniteApps.ps1 catalog style.
// ponytail: flat list, grep-and-extend; a schema/registry is overkill.

const CATALOG = [
  // Web browsers
  { name: 'Brave', repo: 'brave/brave-browser', match: /Brave/i },
  // Media
  { name: 'Audacity', repo: 'audacity/audacity', match: /^Audacity/i, linux: ['audacity', 'Audacity'] },
  { name: 'HandBrake', repo: 'HandBrake/HandBrake', match: /^HandBrake/i, linux: ['handbrake', 'handbrake-cli', 'handbrake-gtk', 'HandBrake'] },
  // Imaging
  { name: 'Paint.NET', repo: 'paintdotnet/release', match: /paint\.net/i, platforms: ['win32'] },
  { name: 'Greenshot', repo: 'greenshot/greenshot', match: /Greenshot/i, platforms: ['win32'] },
  { name: 'ShareX', repo: 'ShareX/ShareX', match: /ShareX/i, platforms: ['win32'] },
  // File sharing
  { name: 'qBittorrent', repo: 'qbittorrent/qBittorrent', match: /qBittorrent/i, linux: ['qbittorrent', 'qBittorrent'] },
  // Accessibility
  { name: 'NVDA', repo: 'nvaccess/nvda', match: /^NVDA\b|NonVisual Desktop/i, platforms: ['win32'] },
  // Developer tools
  { name: 'Git', repo: 'git-for-windows/git', match: /^Git version|^Git\b.*\(64-bit\)/i, platforms: ['win32'] },
  { name: 'Notepad++', repo: 'notepad-plus-plus/notepad-plus-plus', match: /Notepad\+\+/i, platforms: ['win32'] },
  { name: 'WinMerge', repo: 'WinMerge/winmerge', match: /WinMerge/i, platforms: ['win32'] },
  // Java (Eclipse Temurin / AdoptOpenJDK) — one repo per major version, JRE and JDK alike
  // \D* anchors to the FIRST number after the product name, so "21.0.5+11" can't
  // false-match the 11 entry via its build suffix.
  { name: 'Temurin 8', repo: 'adoptium/temurin8-binaries', match: /(Temurin|AdoptOpenJDK)\D*8(?!\d)/i },
  { name: 'Temurin 11', repo: 'adoptium/temurin11-binaries', match: /(Temurin|AdoptOpenJDK)\D*11(?!\d)/i },
  { name: 'Temurin 17', repo: 'adoptium/temurin17-binaries', match: /(Temurin|AdoptOpenJDK)\D*17(?!\d)/i },
  { name: 'Temurin 21', repo: 'adoptium/temurin21-binaries', match: /(Temurin|AdoptOpenJDK)\D*21(?!\d)/i },
  { name: 'Temurin 25', repo: 'adoptium/temurin25-binaries', match: /(Temurin|AdoptOpenJDK)\D*25(?!\d)/i },
  // Utilities
  { name: 'WinDirStat', repo: 'windirstat/windirstat', match: /WinDirStat/i, platforms: ['win32'] },
  { name: 'Open-Shell', repo: 'Open-Shell/Open-Shell-Menu', match: /Open-Shell|Classic Shell/i, platforms: ['win32'] },
  // Compression
  // NOT p7zip-full: a separate POSIX fork, frozen at 16.02, and in current Debian a
  // transitional stub at "16.02+transitional.1". Matching it to Igor Pavlov's 7-Zip
  // (26.x) reports a 10-major-version update against a version line that is not the
  // installed project's, and the row can never clear. "7zip" IS the official one.
  { name: '7-Zip', repo: 'ip7z/7zip', match: /^7-Zip/i, linux: ['7zip'] },
  { name: 'PeaZip', repo: 'peazip/PeaZip', match: /PeaZip/i, linux: ['peazip', 'PeaZip'] },
  // AI tools
  { name: 'OpenCode', repo: 'anomalyco/opencode', match: /^OpenCode\b/i },
  { name: 'Claude Code', repo: 'anthropics/claude-code', match: /^Claude Code\b/i },
  { name: 'Ollama', repo: 'ollama/ollama', match: /^Ollama\b/i, linux: ['ollama'] },
  { name: 'ComfyUI', repo: 'Comfy-Org/ComfyUI', match: /ComfyUI/i },
  { name: 'CC Switch', repo: 'farion1231/cc-switch', match: /CC.?Switch/i },
  { name: 'OpenAI Codex', repo: 'openai/codex', match: /^Codex\b|OpenAI Codex/i },
  { name: 'MoneyPrinterTurbo', repo: 'harry0703/MoneyPrinterTurbo', match: /MoneyPrinterTurbo/i },
  { name: 'Pi', repo: 'earendil-works/pi', match: /^pi$/i },
  { name: 'Open Design', repo: 'nexu-io/open-design', match: /^Open Design\b/i },
  { name: 'OpenHands', repo: 'OpenHands/OpenHands', match: /OpenHands/i },
  { name: 'LobeHub', repo: 'lobehub/lobehub', match: /LobeHub/i },
  { name: 'GPT4All', repo: 'nomic-ai/gpt4all', match: /GPT4All/i },
  { name: 'Unsloth', repo: 'unslothai/unsloth', match: /Unsloth/i },
  { name: 'GPT Academic', repo: 'binary-husky/gpt_academic', match: /GPT.?Academic/i },
  // Media & downloaders
  { name: 'yt-dlp', repo: 'yt-dlp/yt-dlp', match: /^yt-dlp/i, linux: ['yt-dlp'] },
  { name: 'youtube-dl', repo: 'ytdl-org/youtube-dl', match: /^youtube-dl/i, linux: ['youtube-dl'] },
  { name: 'OBS Studio', repo: 'obsproject/obs-studio', match: /OBS Studio/i, linux: ['obs-studio', 'OBS Studio'] },
  // Networking & remote
  { name: 'Clash Verge Rev', repo: 'clash-verge-rev/clash-verge-rev', match: /Clash Verge/i },
  { name: 'RustDesk', repo: 'rustdesk/rustdesk', match: /RustDesk/i, linux: ['rustdesk', 'RustDesk'] },
  { name: 'v2rayN', repo: '2dust/v2rayN', match: /v2rayN/i },
  { name: 'frp', repo: 'fatedier/frp', match: /^frp\b/i },
  { name: 'RTK', repo: 'rtk-ai/rtk', match: /^RTK\b/i },
  { name: 'Syncthing', repo: 'syncthing/syncthing', match: /^Syncthing\b/i, linux: ['syncthing', 'Syncthing'] },
  { name: 'LocalSend', repo: 'localsend/localsend', match: /LocalSend/i, linux: ['localsend', 'LocalSend'] },
  { name: 'Caddy', repo: 'caddyserver/caddy', match: /^Caddy\b/i, linux: ['caddy'] },
  { name: 'Netdata', repo: 'netdata/netdata', match: /Netdata/i, linux: ['netdata'] },
  // Desktop apps & utilities
  { name: 'PowerToys', repo: 'microsoft/PowerToys', match: /PowerToys/i, platforms: ['win32'] },
  { name: 'Windows Terminal', repo: 'microsoft/terminal', match: /Windows Terminal/i, platforms: ['win32'] },
  { name: 'scrcpy', repo: 'Genymobile/scrcpy', match: /scrcpy/i, linux: ['scrcpy'] },
  { name: 'Stirling PDF', repo: 'Stirling-Tools/Stirling-PDF', match: /Stirling.?PDF/i },
  { name: 'Ventoy', repo: 'ventoy/Ventoy', match: /Ventoy/i },
  { name: 'AppFlowy', repo: 'AppFlowy-IO/AppFlowy', match: /AppFlowy/i },
  { name: 'AFFiNE', repo: 'toeverything/AFFiNE', match: /AFFiNE/i },
  { name: 'Tabby', repo: 'Eugeny/tabby', match: /^Tabby\b/i },
  { name: 'OpenBB', repo: 'OpenBB-finance/OpenBB', match: /OpenBB/i },
  { name: 'World Monitor', repo: 'koala73/worldmonitor', match: /World.?Monitor/i },
  // Developer tools & runtimes
  { name: 'Godot', repo: 'godotengine/godot', match: /^Godot/i, linux: ['godot', 'godot3', 'Godot Engine'] },
  { name: 'Neovim', repo: 'neovim/neovim', match: /^Neovim\b/i, linux: ['neovim', 'Neovim'] },
  { name: 'Zed', repo: 'zed-industries/zed', match: /^Zed\b/i },
  { name: 'Deno', repo: 'denoland/deno', match: /^Deno\b/i, linux: ['deno'] },
  { name: 'Bun', repo: 'oven-sh/bun', match: /^Bun$/i },
  { name: 'uv', repo: 'astral-sh/uv', match: /^uv$/i },
  { name: 'Hugo', repo: 'gohugoio/hugo', match: /^Hugo\b/i, linux: ['hugo'] },
  { name: 'fzf', repo: 'junegunn/fzf', match: /^fzf\b/i, linux: ['fzf'] },
  { name: 'lazygit', repo: 'jesseduffield/lazygit', match: /lazygit/i, linux: ['lazygit'] },
  { name: 'act', repo: 'nektos/act', match: /^act$/i },
  { name: 'Daytona', repo: 'daytonaio/daytona', match: /^Daytona\b/i },
  { name: 'Tailwind CSS CLI', repo: 'tailwindlabs/tailwindcss', match: /Tailwind/i },
  { name: 'Tesseract OCR', repo: 'tesseract-ocr/tesseract', match: /Tesseract/i, linux: ['tesseract-ocr'] },
  { name: 'CodeGraph', repo: 'colbymchenry/codegraph', match: /^CodeGraph\b/i },
  // AI tools (batch 51-100)
  { name: 'Open Interpreter', repo: 'openinterpreter/openinterpreter', match: /Open Interpreter/i },
  { name: 'Cline', repo: 'cline/cline', match: /^Cline\b/i },
  { name: 'gpt4free', repo: 'xtekky/gpt4free', match: /gpt4free/i },
  { name: 'AnythingLLM', repo: 'Mintplex-Labs/anything-llm', match: /AnythingLLM/i },
  { name: 'Daily Stock Analysis', repo: 'ZhuLinsen/daily_stock_analysis', match: /Daily Stock Analysis/i },
  { name: 'Strix', repo: 'usestrix/strix', match: /^Strix\b/i },
  { name: 'Orca', repo: 'stablyai/orca', match: /^Orca\b/i },
  { name: 'Faceswap', repo: 'deepfakes/faceswap', match: /Faceswap/i },
  { name: 'ChatGPT Desktop', repo: 'lencx/ChatGPT', match: /^ChatGPT$/i },
  { name: 'Goose', repo: 'aaif-goose/goose', match: /^Goose\b/i },
  { name: 'Voicebox', repo: 'jamiepine/voicebox', match: /^Voicebox\b/i },
  { name: 'Cherry Studio', repo: 'CherryHQ/cherry-studio', match: /Cherry Studio/i },
  { name: 'CLIProxyAPI', repo: 'router-for-me/CLIProxyAPI', match: /CLIProxyAPI/i },
  { name: 'Upscayl', repo: 'upscayl/upscayl', match: /Upscayl/i },
  { name: 'AIRI', repo: 'moeru-ai/airi', match: /^AIRI$/i },
  { name: 'Multica', repo: 'multica-ai/multica', match: /^Multica\b/i },
  { name: 'Text Generation WebUI', repo: 'oobabooga/textgen', match: /Text Generation WebUI/i },
  { name: 'whisper.cpp', repo: 'ggml-org/whisper.cpp', match: /whisper\.cpp/i },
  // Editors & docs
  { name: 'Atom', repo: 'atom/atom', match: /^Atom$/i },
  { name: 'MarkText', repo: 'marktext/marktext', match: /MarkText/i },
  { name: 'Joplin', repo: 'laurent22/joplin', match: /^Joplin\b/i, linux: ['joplin', 'joplin-desktop', 'Joplin'] },
  { name: 'draw.io Desktop', repo: 'jgraph/drawio-desktop', match: /draw\.io/i, linux: ['drawio', 'draw.io'] },
  { name: 'Typst', repo: 'typst/typst', match: /^Typst\b/i },
  { name: 'DBeaver', repo: 'dbeaver/dbeaver', match: /DBeaver/i, linux: ['dbeaver-ce', 'DBeaver Community'] },
  { name: 'ImHex', repo: 'WerWolv/ImHex', match: /ImHex/i, linux: ['imhex', 'ImHex'] },
  { name: 'Memos', repo: 'usememos/memos', match: /^Memos\b/i },
  // Terminals, shells & CLIs
  { name: 'Alacritty', repo: 'alacritty/alacritty', match: /Alacritty/i, linux: ['alacritty', 'Alacritty'] },
  { name: 'PowerShell', repo: 'PowerShell/PowerShell', match: /^PowerShell 7/i, linux: ['powershell', 'PowerShell'] },
  { name: 'Starship', repo: 'starship/starship', match: /^Starship\b/i, linux: ['starship'] },
  { name: 'ripgrep', repo: 'BurntSushi/ripgrep', match: /ripgrep/i, linux: ['ripgrep'] },
  { name: 'bat', repo: 'sharkdp/bat', match: /^bat$/i, linux: ['bat'] },
  { name: 'mkcert', repo: 'FiloSottile/mkcert', match: /^mkcert\b/i, linux: ['mkcert'] },
  { name: 'lazydocker', repo: 'jesseduffield/lazydocker', match: /lazydocker/i, linux: ['lazydocker'] },
  { name: 'Dive', repo: 'wagoodman/dive', match: /^dive$/i },
  { name: 'Ruff', repo: 'astral-sh/ruff', match: /^Ruff\b/i, linux: ['ruff'] },
  { name: 'NVM for Windows', repo: 'coreybutler/nvm-windows', match: /NVM for Windows/i, platforms: ['win32'] },
  { name: 'Kotlin', repo: 'JetBrains/kotlin', match: /^Kotlin\b/i },
  // Servers & infrastructure
  { name: 'Prometheus', repo: 'prometheus/prometheus', match: /^Prometheus\b/i, linux: ['prometheus'] },
  { name: 'Traefik', repo: 'traefik/traefik', match: /Traefik/i, linux: ['traefik'] },
  { name: 'PocketBase', repo: 'pocketbase/pocketbase', match: /PocketBase/i },
  { name: 'Meilisearch', repo: 'meilisearch/meilisearch', match: /Meilisearch/i },
  { name: 'Gitea', repo: 'go-gitea/gitea', match: /^Gitea\b/i, linux: ['gitea'] },
  { name: 'Gogs', repo: 'gogs/gogs', match: /^Gogs\b/i },
  { name: 'etcd', repo: 'etcd-io/etcd', match: /^etcd\b/i, linux: ['etcd', 'etcd-server'] },
  { name: 'rclone', repo: 'rclone/rclone', match: /^rclone\b/i, linux: ['rclone'] },
  { name: 'AList', repo: 'AlistGo/alist', match: /^AList\b/i },
  // Desktop apps
  { name: 'Motrix', repo: 'agalwood/Motrix', match: /Motrix/i, linux: ['motrix', 'Motrix'] },
  { name: 'LX Music Desktop', repo: 'lyswhut/lx-music-desktop', match: /LX Music/i },
  { name: 'Spotube', repo: 'KRTirtho/spotube', match: /Spotube/i },
  { name: 'FlClash', repo: 'chen08209/FlClash', match: /FlClash/i },
];

// Does this catalog entry apply to the given OS? No `platforms` field means "all".
function onPlatform(entry, platform) {
  return !entry.platforms || entry.platforms.includes(platform || process.platform);
}

// Find this entry's installed row, matching the way the platform's namespace requires.
//
// Windows and macOS inventories are HUMAN-FACING names — "7-Zip 26.02 (x64 edition)",
// "OBS Studio.app" — a hundred or so of them, with version numbers and edition suffixes
// baked in. A loose regex is the right tool: the surface is small and the names vary.
//
// A Linux inventory is nothing like that. It is thousands of short MACHINE identifiers
// (2825 on one ordinary desktop), a large fraction of them lib-prefixed variants, and
// many of them ordinary English words. The same regexes misfire badly there:
//
//   /Tesseract/i  matched libtesseract5, a shared library, not the application
//   /^Orca\b/i    matched orca, the GNOME screen reader, unrelated to stablyai/orca
//   /^7-Zip/i     MISSED the real thing, because the package is named "7zip"
//
// So Linux matches declared identifiers EXACTLY, and an entry with none is simply not
// offered there. Failing to offer a real app is a missing row; offering someone their
// screen reader as an updatable GitHub app is worse. The list holds every namespace an
// entry appears in — dpkg/rpm package names, and the human name flatpak and snap report.
function findInstalled(entry, installed, platform) {
  const rows = installed || [];
  if (platform === 'linux') {
    if (!entry.linux || !entry.linux.length) return null;
    const want = new Set(entry.linux.map((s) => s.toLowerCase()));
    return rows.find((e) => want.has(String(e.DisplayName || '').toLowerCase())) || null;
  }
  return rows.find((e) => entry.match.test(e.DisplayName)) || null;
}

// installed: [{DisplayName, DisplayVersion}]; trackedRepos: Set of "owner/repo" (lowercase).
// platform defaults to the running OS; entries for other OSes are skipped entirely.
// Returns [{name, repo, displayName, version, tracked}] — one row per catalog hit.
function matchInstalled(installed, trackedRepos, platform) {
  const plat = platform || process.platform;
  const out = [];
  for (const entry of CATALOG) {
    if (!onPlatform(entry, plat)) continue;
    const hit = findInstalled(entry, installed, plat);
    if (!hit) continue;
    out.push({
      name: entry.name,
      repo: entry.repo,
      displayName: hit.DisplayName,
      version: hit.DisplayVersion || '',
      tracked: !!(trackedRepos && trackedRepos.has(entry.repo.toLowerCase())),
    });
  }
  return out;
}

module.exports = { CATALOG, matchInstalled, onPlatform, findInstalled };
