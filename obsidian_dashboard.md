---
type: dashboard
tags: [dashboard, homepage]
---

# 🏠 Second Brain Dashboard

```dataviewjs
// ============ CONFIG ============
// Adjust folder names to match your vault structure
const folderLabels = {
  "100-Learning/Research":  { text: "Research",  color: "#a78bfa", emoji: "🔍" },
  "100-Learning/Topics":    { text: "Learning",  color: "#34d399", emoji: "📚" },
  "100-Learning/Study":     { text: "Study",     color: "#60a5fa", emoji: "🎓" },
  "100-Learning/Reviews":   { text: "Reviews",   color: "#fbbf24", emoji: "⭐" },
  "200-Projects":           { text: "Projects",  color: "#f87171", emoji: "🚀" },
  "300-Areas":              { text: "Areas",     color: "#fb923c", emoji: "🌿" },
};

// ============ HEADER ============
const header = dv.el("div", "");
header.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--background-modifier-border);`;
const greeting = header.createDiv();
const hour = new Date().getHours();
const greetText = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
greeting.createEl("h2", {text: `${greetText} 🧠`}).style.cssText = "margin:0;";
const dateDiv = header.createDiv();
dateDiv.textContent = new Date().toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'});
dateDiv.style.cssText = "font-size:0.9em;opacity:0.7;";

// ============ STATS ============
const statsRow = dv.el("div","");
statsRow.style.cssText = "display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;";
const allTasks = dv.pages().file.tasks;
const openTasks = allTasks.where(t => !t.completed).length;
const todayStr = dv.date("today").toFormat("yyyy-MM-dd");
const todayNote = dv.pages('"_daily"').where(p => p.file.name === todayStr).first();
const todayCompleted = todayNote ? todayNote.file.tasks.where(t => t.completed).length : 0;

// Recent pipeline jobs (notes created in last 24 hours)
const recentNotes = dv.pages('"100-Learning"').where(p => {
  const age = dv.date("today") - p.file.cday;
  return age && age.days < 2;
}).length;

function statCard(emoji, label, value, color) {
  const card = statsRow.createDiv();
  card.style.cssText = `background:var(--background-secondary);padding:14px 18px;border-radius:8px;min-width:130px;border-left:4px solid ${color};`;
  card.createDiv({text:`${emoji} ${label}`}).style.cssText = "font-size:0.8em;opacity:0.7;margin-bottom:4px;";
  card.createDiv({text:String(value)}).style.cssText = `font-size:1.4em;font-weight:bold;color:${color};`;
}
statCard("📋","Open Tasks", openTasks, "#60a5fa");
statCard("✅","Done Today", todayCompleted, "#34d399");
statCard("🔍","New Notes (24h)", recentNotes, "#a78bfa");

// ============ FOLDER SHORTCUTS ============
const shortcuts = dv.el("div","");
shortcuts.style.cssText = "display:flex;gap:10px;margin-bottom:24px;flex-wrap:wrap;";
for (const [folder, info] of Object.entries(folderLabels)) {
  const count = dv.pages(`"${folder}"`).length;
  const card = shortcuts.createDiv();
  card.style.cssText = `background:var(--background-secondary);padding:14px 18px;border-radius:8px;cursor:pointer;border-top:3px solid ${info.color};min-width:110px;text-align:center;transition:transform 0.1s;`;
  card.onmouseenter = () => card.style.transform = "translateY(-2px)";
  card.onmouseleave = () => card.style.transform = "translateY(0)";
  card.onclick = () => app.workspace.openLinkText(folder,"",false);
  card.createDiv({text:info.emoji}).style.cssText = "font-size:1.4em;margin-bottom:4px;";
  card.createDiv({text:info.text}).style.cssText = "font-size:0.85em;font-weight:500;";
  card.createDiv({text:`${count} notes`}).style.cssText = "font-size:0.7em;opacity:0.5;";
}

// ============ TASK KANBAN ============
dv.el("h3","📋 Tasks").style.cssText = "margin:0 0 12px 0;";
const tasks = dv.pages().file.tasks.where(t => !t.completed);
const dvToday = dv.date("today");
const jsToday = new Date();
const dow = jsToday.getDay();
const weekEnd = dvToday.plus({days: 6 - dow});
const nextWeekEnd = weekEnd.plus({days:7});

const todayTasks    = tasks.filter(t => t.due && t.due.ts <= dvToday.ts);
const thisWeekTasks = tasks.filter(t => t.due && t.due.ts > dvToday.ts && t.due.ts <= weekEnd.ts);
const laterTasks    = tasks.filter(t => t.due && t.due.ts > weekEnd.ts);
const noDueTasks    = tasks.filter(t => !t.due);

const kanban = dv.el("div","");
kanban.style.cssText = "display:flex;gap:12px;margin-bottom:24px;overflow-x:auto;padding-bottom:8px;";

function renderCol(container, title, color, taskList) {
  const col = container.createDiv();
  col.style.cssText = `flex:1;min-width:200px;max-width:280px;background:var(--background-secondary);border-radius:8px;padding:12px;border-top:3px solid ${color};`;
  const hdr = col.createDiv();
  hdr.style.cssText = "display:flex;justify-content:space-between;margin-bottom:10px;";
  hdr.createEl("h4",{text:title}).style.cssText = "margin:0;font-size:0.85em;";
  const badge = hdr.createSpan({text:String(taskList.length)});
  badge.style.cssText = `background:${color}33;color:${color};padding:2px 8px;border-radius:10px;font-size:0.75em;`;
  const list = col.createDiv();
  list.style.cssText = "max-height:35vh;overflow-y:auto;";
  if (taskList.length === 0) {
    list.createDiv({text:"All clear ✓"}).style.cssText = "color:var(--text-muted);font-size:0.8em;padding:8px;text-align:center;opacity:0.5;";
  } else {
    for (const t of taskList) {
      const item = list.createDiv();
      item.style.cssText = "background:var(--background-primary);padding:8px 10px;margin-bottom:5px;border-radius:5px;font-size:0.82em;cursor:pointer;";
      item.onclick = () => app.workspace.openLinkText(t.path,"",false);
      const txt = t.text.replace(/[📅🛫⏫🔼🔽🔁✅]\s*\d{4}-\d{2}-\d{2}/g,"").replace(/[📅🛫⏫🔼🔽🔁]/g,"").trim();
      item.createSpan({text: txt.length > 60 ? txt.slice(0,60)+"…" : txt});
    }
  }
}
renderCol(kanban,"🔴 Today",    "#ef4444", todayTasks.array());
renderCol(kanban,"🟠 This Week","#f59e0b", thisWeekTasks.array());
renderCol(kanban,"🟣 Later",    "#8b5cf6", laterTasks.array());
renderCol(kanban,"⚪ No Date",  "#6b7280", noDueTasks.array());

// ============ PIPELINE ACTIVITY (Recent notes) ============
dv.el("h3","🔍 Recent Pipeline Output").style.cssText = "margin:0 0 12px 0;";
const pipeline = dv.pages('"100-Learning"')
  .where(p => p.type === "research" || p.type === "note")
  .sort(p => p.file.mtime, "desc")
  .limit(8);

const pipelineContainer = dv.el("div","");
pipelineContainer.style.cssText = "background:var(--background-secondary);border-radius:8px;overflow:hidden;margin-bottom:24px;";
for (const note of pipeline) {
  const row = pipelineContainer.createDiv();
  row.style.cssText = "padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--background-modifier-border);display:flex;justify-content:space-between;align-items:center;";
  row.onmouseenter = () => row.style.background = "var(--background-primary)";
  row.onmouseleave = () => row.style.background = "transparent";
  row.onclick = () => app.workspace.openLinkText(note.file.path,"",false);
  row.createSpan({text: note.file.name}).style.cssText = "font-size:0.88em;";
  const meta = row.createDiv();
  meta.style.cssText = "display:flex;gap:8px;align-items:center;";
  if (note.tags && note.tags.length) {
    const tag = meta.createSpan({text:`#${note.tags[0]}`});
    tag.style.cssText = "font-size:0.7em;opacity:0.5;";
  }
  meta.createSpan({text: note.file.mtime.toFormat("MMM d")}).style.cssText = "font-size:0.75em;opacity:0.5;";
}


// ============ HABITS TRACKER ============
dv.el("h3","🏃 Habits — Last 7 Days").style.cssText = "margin:0 0 12px 0;";

// Define your habits here — match the text exactly as it appears in your daily notes
const habitDefs = [
  { name: "Exercise",           emoji: "🏃" },
  { name: "Read",               emoji: "📖" },
  { name: "Meditate",           emoji: "🧘" },
  { name: "No alcohol",         emoji: "🚫" },
  { name: "8 hours sleep",      emoji: "😴" },
  { name: "Healthy eating",     emoji: "🥗" },
];

const habitsContainer = dv.el("div","");
habitsContainer.style.cssText = "background:var(--background-secondary);padding:16px;border-radius:8px;margin-bottom:24px;";

// Get last 7 daily notes
const last7 = dv.pages('"_daily"')
  .where(p => p.file.name.match(/^\d{4}-\d{2}-\d{2}$/))
  .sort(p => p.file.name, 'desc')
  .limit(7)
  .array()
  .reverse();

// Header row with dates
const headerRow = habitsContainer.createDiv();
headerRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--background-modifier-border);";
headerRow.createDiv({text:""}).style.cssText = "width:200px;flex-shrink:0;";
for (const note of last7) {
  const d = note.file.name.slice(5); // MM-DD
  const label = headerRow.createDiv({text: d});
  label.style.cssText = "width:34px;text-align:center;font-size:0.7em;opacity:0.5;font-family:monospace;flex-shrink:0;";
}

for (const habit of habitDefs) {
  const row = habitsContainer.createDiv();
  row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";

  row.createDiv({text:`${habit.emoji} ${habit.name}`}).style.cssText = "width:200px;font-size:0.82em;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

  let streak = 0;
  for (const note of last7) {
    const dot = row.createDiv();
    dot.style.cssText = "width:34px;height:28px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:0.72em;flex-shrink:0;";

    const tasks = note.file.tasks.where(t => t.text.toLowerCase().includes(habit.name.toLowerCase()));
    if (tasks.length === 0) {
      dot.style.background = "var(--background-primary)";
      dot.textContent = "—";
      dot.style.opacity = "0.25";
      streak = 0;
    } else if (tasks[0].completed) {
      dot.style.background = "#16a34a";
      dot.textContent = "✓";
      dot.style.color = "white";
      streak++;
    } else {
      dot.style.background = "#dc2626";
      dot.textContent = "✗";
      dot.style.color = "white";
      streak = 0;
    }
  }
  // Streak badge
  if (streak > 1) {
    row.createDiv({text:`${streak}🔥`}).style.cssText = "font-size:0.75em;margin-left:6px;";
  }
}

// ============ DAILY NOTE QUICK LINK ============
const dailyBar = dv.el("div","");
dailyBar.style.cssText = "background:var(--background-secondary);padding:12px 16px;border-radius:8px;display:flex;align-items:center;gap:12px;margin-bottom:16px;";
dailyBar.createSpan({text:"📅"});
const hasDailyNote = dv.pages('"_daily"').where(p => p.file.name === todayStr).length > 0;
dailyBar.createSpan({text: hasDailyNote ? `Today's note exists` : `No daily note yet — tell OpenClaw: "daily:"`}).style.cssText = "flex:1;font-size:0.85em;opacity:0.7;";
const openDaily = dailyBar.createEl("a",{text: hasDailyNote ? "→ Open" : "→ Create"});
openDaily.style.cssText = "font-size:0.85em;cursor:pointer;";
openDaily.onclick = () => app.workspace.openLinkText(`_daily/${todayStr}`,"",false);
```
