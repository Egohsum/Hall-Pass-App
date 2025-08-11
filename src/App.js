import React, { useEffect, useMemo, useRef } from "react";
import usePersistentState from "./hooks/usePersistentState";
import { CLOUD_ENABLED } from "./lib/supabaseClient";
import {
  cloudFetchActive,
  cloudStartPass,
  cloudEndPass,
  cloudFetchRoster,
  cloudUpsertStudent,
  cloudSubscribeActive,
} from "./lib/cloud";

/* ===================== Helpers ===================== */
const OCC_LIMIT_PER_DEST = 4;
const now = () => Date.now();
const mkId = () => Math.random().toString(36).slice(2);
const pad2 = (n) => String(n).padStart(2, "0");
const dateLocal = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const timeLocal = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  let h = d.getHours();
  const m = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m}:${s} ${ampm}`;
};
const fmtDuration = (ms) => {
  if (!ms || ms < 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const mm = pad2(Math.floor(total / 60));
  const ss = pad2(total % 60);
  return `${mm}:${ss}`;
};
const toMMSS = (ms) => {
  if (!ms || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const m = pad2(Math.floor(total / 60));
  const s = pad2(total % 60);
  return `${m}:${s}`;
};
const csvEscape = (v) => {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};
function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { headers: [], data: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const data = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, idx) => (row[h] = (cells[idx] || "").trim()));
    return row;
  });
  return { headers, data };
}
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    o.start();
    setTimeout(() => { o.frequency.value = 660; }, 120);
    setTimeout(() => {
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.02);
      o.stop(ctx.currentTime + 0.04);
    }, 240);
  } catch {}
}
const extractDigits = (str) => (String(str || "").match(/(\d{4,})/) || [,""])[1];
const extractStudentId = (raw) => {
  const m = String(raw).match(/(\d{5,})/);
  return m ? m[1] : String(raw).trim();
};

/* ===================== App ===================== */
export default function App() {
  // Tabs: dashboard | flyers | roster | live
  const [tab, setTab] = usePersistentState("hp.tab", "dashboard");

  // Filters & settings
  const [periodFilter, setPeriodFilter] = usePersistentState("hp.periodFilter", "1");
  const [destination, setDestination] = usePersistentState("hp.destination", "Bathroom");
  const [maxMinutes, setMaxMinutes] = usePersistentState("hp.maxMinutes", 8);
  const [bannerMsg] = usePersistentState("hp.bannerMsg", "Hall Pass System Ready");
  const [showDaily, setShowDaily] = usePersistentState("hp.showDaily", true);
  const [showWeekly, setShowWeekly] = usePersistentState("hp.showWeekly", false);

  // Pass data (local cache)
  const [active, setActive] = usePersistentState("hp.active", []);
  const [history, setHistory] = usePersistentState("hp.history", []);

  // Roster cache: { id: { name, period } }
  const [roster, setRoster] = usePersistentState("hp.roster", {});

  // Scan station settings
  const [scanMode, setScanMode] = usePersistentState("hp.scanMode", false);
  const [stationDestination, setStationDestination] = usePersistentState("hp.stationDestination", "Bathroom");
  const [stationMaxMinutes, setStationMaxMinutes] = usePersistentState("hp.stationMaxMinutes", 8);

  // Admin badge flow
  const [adminId, setAdminId] = usePersistentState("hp.adminId", null);
  const [adminMode, setAdminMode] = usePersistentState("hp.adminMode", false);
  const [adminPending, setAdminPending] = usePersistentState("hp.adminPending", null); // 'enroll' | 'unlock' | null
  const [adminExpiresAt, setAdminExpiresAt] = usePersistentState("hp.adminExpiresAt", 0);
  const [adminCountdown, setAdminCountdown] = usePersistentState("hp.adminCountdown", 0);

  // Toast
  const [toast, setToast] = usePersistentState("hp.toast", { show: false, message: "", tone: "success" });
  const showToast = (message, tone = "success") => {
    setToast({ show: true, message, tone });
    setTimeout(() => setToast({ show: false, message: "", tone }), 2500);
  };

  // Scan buffer
  const scanBufferRef = useRef("");
  const scanTimerRef = useRef(null);
  const [lastScan, setLastScan] = usePersistentState("hp.lastScan", "");

  /* ---------- Cloud bootstrap & realtime ---------- */
  useEffect(() => {
    if (!CLOUD_ENABLED) return;

    (async () => {
      try {
        const r = await cloudFetchRoster();
        if (!r.error && Array.isArray(r.data)) {
          const merged = {};
          for (const row of r.data) merged[row.student_id] = { name: row.name, period: row.period || null };
          if (Object.keys(merged).length) setRoster(merged);
        }
        const a = await cloudFetchActive();
        if (!a.error && Array.isArray(a.data)) {
          const mapped = a.data
            .map((row) => ({
              id: row.id,
              student: row.student_name,
              studentId: row.student_id || null,
              destination: row.destination,
              period: String(row.period ?? ""),
              reason: "",
              startTime: new Date(row.start_time).getTime(),
              endTime: row.end_time ? new Date(row.end_time).getTime() : null,
              maxMinutes: row.max_minutes || 0,
              overLimit: !!row.over_limit,
              lateReason: row.late_reason || "",
            }))
            .filter((p) => !p.endTime);
          setActive(mapped);
        }
      } catch (e) {
        console.warn("Cloud bootstrap failed:", e);
      }
    })();

    const off = cloudSubscribeActive(async () => {
      const a = await cloudFetchActive();
      if (!a.error && Array.isArray(a.data)) {
        const mapped = a.data
          .map((row) => ({
            id: row.id,
            student: row.student_name,
            studentId: row.student_id || null,
            destination: row.destination,
            period: String(row.period ?? ""),
            reason: "",
            startTime: new Date(row.start_time).getTime(),
            endTime: row.end_time ? new Date(row.end_time).getTime() : null,
            maxMinutes: row.max_minutes || 0,
            overLimit: !!row.over_limit,
            lateReason: row.late_reason || "",
          }))
          .filter((p) => !p.endTime);
        setActive(mapped);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Admin countdown ---------- */
  useEffect(() => {
    if (!adminMode) return;
    function tick() {
      const secs = Math.max(0, Math.ceil((adminExpiresAt - Date.now()) / 1000));
      setAdminCountdown(secs);
      if (secs <= 0) {
        setAdminMode(false);
        setAdminExpiresAt(0);
        setAdminPending(null);
        setAdminCountdown(0);
        showToast("Admin locked");
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminMode, adminExpiresAt]);

  /* ---------- Keyboard scanner ---------- */
  useEffect(() => {
    if (!scanMode && !adminPending) return;

    const flush = () => {
      const code = scanBufferRef.current.trim();
      scanBufferRef.current = "";
      if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
      if (code) { setLastScan(code); handleScan(code); }
    };

    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.isComposing) return;
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); flush(); return; }
      if (e.key.length === 1) {
        scanBufferRef.current += e.key;
        if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
        scanTimerRef.current = setTimeout(() => { if (scanBufferRef.current.length >= 5) flush(); }, 600);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanMode, adminPending, roster, active, periodFilter, stationDestination, stationMaxMinutes, adminId, adminMode]);

  /* ---------- Core actions ---------- */
  function startPass({ student, dest, period, maxM, studentId = null }) {
    const count = active.filter((p) => p.destination === dest && String(p.period) === String(period)).length;
    if (count >= OCC_LIMIT_PER_DEST) {
      showToast(`${dest} (Period ${period}): limit of ${OCC_LIMIT_PER_DEST} reached`, "error");
      return false;
    }

    const pass = {
      id: mkId(),
      student,
      studentId,
      destination: dest,
      period: String(period),
      reason: "",
      startTime: now(),
      endTime: null,
      maxMinutes: typeof maxM === "number" ? maxM : 0,
      overLimit: false,
      lateReason: "",
    };

    setActive((a) => [pass, ...a]); // optimistic
    cloudStartPass(pass).then(({ error }) => { if (error) console.warn("cloudStartPass", error); });
    return true;
  }

  function endPass(id) {
    setActive((prev) => {
      const p = prev.find((x) => x.id === id);
      if (!p) return prev;
      const ended = { ...p, endTime: now() };

      let over = false;
      if (ended.maxMinutes && ended.startTime && ended.endTime) {
        const diffMin = (ended.endTime - ended.startTime) / 60000;
        over = diffMin > ended.maxMinutes;
      }
      ended.overLimit = over;
      if (ended.overLimit) {
        playChime();
        const reason = window.prompt(`Late return for ${ended.student}. Enter reason:`, "");
        ended.lateReason = reason ? reason.trim() : "";
      }

      cloudEndPass(id, ended).then(({ error }) => { if (error) console.warn("cloudEndPass", error); });
      setHistory((h) => [ended, ...h]); // local history
      return prev.filter((x) => x.id !== id);
    });
  }

  function handleScan(rawCode) {
    // Admin flow
    if (adminPending === "enroll") {
      const digits = extractDigits(rawCode);
      if (!digits) { showToast("Could not read digits from badge", "error"); setAdminPending(null); return; }
      setAdminId(digits);
      setAdminPending(null);
      showToast("Admin badge set ✅");
      return;
    }
    if (adminPending === "unlock") {
      const digits = extractDigits(rawCode);
      setAdminPending(null);
      if (digits === adminId) {
        setAdminMode(true);
        const until = Date.now() + 180 * 1000;
        setAdminExpiresAt(until);
        showToast("Admin unlocked for 180s");
      } else {
        showToast("Badge not recognized for admin", "error");
      }
      return;
    }

    // Student flow
    const sid = extractStudentId(rawCode);
    let entry = roster[sid];
    if (!entry) {
      const nm = window.prompt(`Unknown ID: ${sid}. Enter student name:`, "");
      if (!nm) return;
      let p = periodFilter === "All" ? window.prompt("Enter this student's period (1–6):", "") : periodFilter;
      p = Number(p);
      if (!p || p < 1 || p > 6) { showToast("Invalid period. Scan cancelled.", "error"); return; }
      entry = { name: nm.trim(), period: p };
      setRoster((r) => ({ ...r, [sid]: entry }));
      cloudUpsertStudent(sid, entry.name, entry.period);
    }

    const name = entry.name?.trim() || "";
    const rosterPeriod = Number(entry.period) || null;
    const usePeriod = rosterPeriod || (periodFilter !== "All" ? Number(periodFilter) : null);
    if (!usePeriod) { showToast("Select a period or add one to the roster entry", "error"); return; }

    const existing = active.find((p) => (p.student || "").toLowerCase() === name.toLowerCase() && !p.endTime);
    if (existing) { endPass(existing.id); return; }

    const ok = startPass({
      student: name,
      studentId: sid,
      dest: stationDestination || destination,
      period: usePeriod,
      maxM: Number(stationMaxMinutes) || 0,
    });
    if (ok && periodFilter !== String(usePeriod)) setPeriodFilter(String(usePeriod));
  }

  /* ---------- CSV & Flyers ---------- */
  function exportHistoryCSV() {
    const filtered = periodFilter === "All" ? history : history.filter((p) => String(p.period) === String(periodFilter));
    const sorted = [...filtered].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    const rows = [
      ["Student", "Period", "Destination", "Date", "Start Time", "End Time", "Duration (mm:ss)", "Late", "Late Reason", "Max (mins)"],
      ...sorted.map((p) => [
        p.student || "",
        p.period || "",
        p.destination || "",
        dateLocal(p.startTime),
        timeLocal(p.startTime),
        timeLocal(p.endTime),
        p.endTime && p.startTime ? fmtDuration(p.endTime - p.startTime) : "",
        p.overLimit ? "TRUE" : "FALSE",
        p.overLimit ? p.lateReason || "" : "",
        typeof p.maxMinutes === "number" ? p.maxMinutes : "",
      ]),
    ];
    const filePeriod = periodFilter === "All" ? "All" : `P${periodFilter}`;
    downloadCSV(`Pass_History_${filePeriod}.csv`, rows);
  }

  const flyersByPeriod = useMemo(() => {
    const src = periodFilter === "All" ? history : history.filter((p) => String(p.period) === String(periodFilter));
    const map = new Map();
    for (const p of src) {
      const key = p.student;
      const prev = map.get(key) || { name: key, count: 0, totalMs: 0, late: 0, lastSeen: 0 };
      prev.count += 1;
      if (p.endTime && p.startTime) prev.totalMs += p.endTime - p.startTime;
      if (p.overLimit) prev.late += 1;
      if (p.endTime || p.startTime) prev.lastSeen = Math.max(prev.lastSeen, p.endTime || p.startTime);
      map.set(key, prev);
    }
    const arr = Array.from(map.values());
    arr.forEach((x) => {
      x.avgMs = x.count ? x.totalMs / x.count : 0;
      x.latePct = x.count ? Math.round((x.late / x.count) * 1000) / 10 : 0;
    });
    return arr.sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);
  }, [history, periodFilter]);

  function exportFlyersCSV() {
    const rows = [
      ["Student", "Passes", "Avg (mm:ss)", "Total (mm:ss)", "Late Count", "Late %", "Last Seen"],
      ...flyersByPeriod.map((s) => [
        s.name,
        s.count,
        toMMSS(s.avgMs),
        toMMSS(s.totalMs),
        s.late,
        s.latePct,
        s.lastSeen ? `${dateLocal(s.lastSeen)} ${timeLocal(s.lastSeen)}` : "",
      ]),
    ];
    const filePeriod = periodFilter === "All" ? "All" : `P${periodFilter}`;
    downloadCSV(`Frequent_Flyers_${filePeriod}.csv`, rows);
  }

  /* ---------- Derived UI data ---------- */
  const periodOptions = ["1", "2", "3", "4", "5", "6", "All"];
  const activeFiltered = useMemo(
    () => (periodFilter === "All" ? active : active.filter((p) => String(p.period) === String(periodFilter))),
    [active, periodFilter]
  );
  const historyFiltered = useMemo(
    () => (periodFilter === "All" ? history : history.filter((p) => String(p.period) === String(periodFilter))),
    [history, periodFilter]
  );
  const historySorted = useMemo(
    () => [...historyFiltered].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)),
    [historyFiltered]
  );

  // Daily/Weekly summaries
  const isToday = (ts) => {
    const d = new Date(ts); const t = new Date();
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  };
  const isThisWeek = (ts) => {
    const d = new Date(ts); const t = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const monday = new Date(day(t).getTime() - ((t.getDay() + 6) % 7) * 86400000);
    const nextMonday = new Date(monday.getTime() + 7 * 86400000);
    return d >= monday && d < nextMonday;
  };
  const daily = useMemo(() => history.filter((p) => isToday(p.startTime)), [history]);
  const weekly = useMemo(() => history.filter((p) => isThisWeek(p.startTime)), [history]);
  const summarize = (list) => {
    if (!list.length) return { avgMin: 0, count: 0, busiest: "-", late: 0 };
    const count = list.length; let totalMs = 0; let late = 0; const destCount = {};
    for (const p of list) {
      if (p.endTime && p.startTime) totalMs += p.endTime - p.startTime;
      if (p.overLimit) late++;
      destCount[p.destination] = (destCount[p.destination] || 0) + 1;
    }
    const avgMin = Math.round((totalMs / count / 60000) * 10) / 10 || 0;
    let busiest = "-"; let maxC = 0;
    for (const [d, c] of Object.entries(destCount)) { if (c > maxC) { maxC = c; busiest = d; } }
    return { avgMin, count, busiest, late };
  };
  const dailySum = useMemo(() => summarize(daily), [daily]);
  const weeklySum = useMemo(() => summarize(weekly), [weekly]);

  /* ===================== UI ===================== */
  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 8, background: "#eef2ff", color: "#3730a3", fontWeight: 600 }}>
        {bannerMsg} {CLOUD_ENABLED ? "• Cloud: ON" : "• Cloud: OFF"}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Hall Pass Manager</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setTab("dashboard")} style={tabBtnStyle(tab === "dashboard")}>Dashboard</button>
          <button onClick={() => setTab("flyers")} style={tabBtnStyle(tab === "flyers")}>Frequent Flyers</button>
          <button onClick={() => setTab("roster")} style={tabBtnStyle(tab === "roster")}>Roster</button>
          <button onClick={() => setTab("live")} style={tabBtnStyle(tab === "live")}>Live</button>
        </div>
      </div>

      {/* Admin controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {!adminId ? (
          <button onClick={() => { setAdminPending("enroll"); showToast("Scan your admin badge to set it", "info"); }} style={btn}>Set Admin Badge</button>
        ) : (
          <>
            {!adminMode ? (
              <button onClick={() => { setAdminPending("unlock"); showToast("Scan admin badge to unlock", "info"); }} style={btn}>Unlock Admin (Scan)</button>
            ) : (
              <>
                <span style={{ fontSize:12, padding:"4px 8px", background:"#111827", color:"#fff", borderRadius:999 }}>
                  Admin ON {adminCountdown}s
                </span>
                <button onClick={() => {
                  setAdminMode(false); setAdminExpiresAt(0); setAdminPending(null); setAdminCountdown(0); showToast("Admin locked");
                }} style={btn}>Lock Now</button>
              </>
            )}
          </>
        )}

        {/* Manual badge entry */}
        <input
          placeholder="Type badge code"
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const v = e.currentTarget.value.trim();
            if (!v) return;
            if (adminPending === "enroll") {
              const digits = extractDigits(v);
              if (!digits) showToast("Could not read digits from badge", "error");
              else { setAdminId(digits); setAdminPending(null); showToast("Admin badge set ✅"); }
            } else if (adminPending === "unlock") {
              const digits = extractDigits(v);
              setAdminPending(null);
              if (digits === adminId) {
                setAdminMode(true);
                const until = Date.now() + 180 * 1000;
                setAdminExpiresAt(until);
                showToast("Admin unlocked for 180s");
              } else {
                showToast("Badge not recognized for admin", "error");
              }
            } else {
              showToast("Click Enroll or Unlock first", "info");
            }
            e.currentTarget.value = "";
          }}
          style={{ ...inputStyle, minWidth: 180 }}
        />
      </div>

      {/* Scan panel */}
      <section style={{ background:"#fff", border:"1px solid #e5e7eb", borderRadius:10, padding:"12px", marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <label style={{ fontWeight:600, display:"flex", alignItems:"center", gap:8 }}>
            <input type="checkbox" checked={scanMode} onChange={(e) => setScanMode(e.target.checked)} />
            Scan Mode
          </label>

          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#6b7280", fontSize:12 }}>Station Destination</span>
            <select value={stationDestination} onChange={(e) => setStationDestination(e.target.value)} style={selectStyle}>
              <option>Bathroom</option><option>Nurse</option><option>Front Office</option>
              <option>Counselor</option><option>Locker</option><option>Water</option><option>Other</option>
            </select>

            <span style={{ color:"#6b7280", fontSize:12 }}>Max (min)</span>
            <input
              type="number" min={0} max={120} value={stationMaxMinutes}
              onChange={(e) => setStationMaxMinutes(Math.max(0, Math.min(120, Number(e.target.value)||0)))}
              style={{ width:70, ...inputStyle }}
            />
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", width:"100%", marginTop:10 }}>
          <label style={{ fontSize:12, color:"#374151" }}>
            Import roster (studentId, firstName, lastName, period)
          </label>
          <input type="file" accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const txt = String(reader.result || "");
                const { headers, data } = parseCSV(txt);
                const lower = headers.map(h => h.toLowerCase());
                const idH = headers[lower.findIndex(h => ["studentid","id"].includes(h))];
                const fnH = headers[lower.findIndex(h => ["firstname","first name","first"].includes(h))];
                const lnH = headers[lower.findIndex(h => ["lastname","last name","last"].includes(h))];
                const perH = headers[lower.findIndex(h => ["period","class period"].includes(h))];
                if (!idH || !perH || (!fnH && !lnH)) { showToast("CSV needs: studentId, firstName, lastName, period", "error"); return; }
                const merged = { ...roster }; let count = 0;
                for (const row of data) {
                  const sid = String(row[idH] || "").trim();
                  const first = String(row[fnH] || "").trim();
                  const last = String(row[lnH] || "").trim();
                  const per = Number(row[perH] || "");
                  if (!sid || !first || !last || !per) continue;
                  merged[sid] = { name: `${first} ${last}`.trim(), period: per };
                  cloudUpsertStudent(sid, merged[sid].name, per);
                  count++;
                }
                setRoster(merged);
                showToast(`Imported/updated ${count} students with periods`);
              };
              reader.readAsText(file);
            }}
          />
          {scanMode && lastScan && (
            <div style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
              Last scan: <strong>{lastScan}</strong>
            </div>
          )}
        </div>
      </section>

      {/* Tabs */}
      {tab === "dashboard" && (
        <>
          <section style={cardStyle}>
            <div style={{ display:"flex", gap:12, flexWrap:"wrap", alignItems:"center" }}>
              <label style={lbl}>Period</label>
              <select value={periodFilter} onChange={(e)=>setPeriodFilter(e.target.value)} style={selectStyle}>
                {["1","2","3","4","5","6","All"].map(p => <option key={p} value={p}>{p}</option>)}
              </select>

              <label style={lbl}>Destination</label>
              <select value={destination} onChange={(e)=>setDestination(e.target.value)} style={selectStyle}>
                <option>Bathroom</option><option>Nurse</option><option>Front Office</option>
                <option>Counselor</option><option>Locker</option><option>Water</option><option>Other</option>
              </select>

              <label style={lbl}>Max (min)</label>
              <input type="range" min={0} max={60} value={maxMinutes} onChange={(e)=>setMaxMinutes(Number(e.target.value))} style={{ width:160 }}/>
              <span style={{ fontWeight:600 }}>{maxMinutes} min</span>

              <div style={{ marginLeft:"auto", display:"flex", gap:12, alignItems:"center" }}>
                <label style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <input type="checkbox" checked={showDaily} onChange={(e)=>setShowDaily(e.target.checked)} />
                  Daily summary
                </label>
                <label style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <input type="checkbox" checked={showWeekly} onChange={(e)=>setShowWeekly(e.target.checked)} />
                  Weekly summary
                </label>
              </div>
            </div>
          </section>

          {(showDaily || showWeekly) && (
            <section style={{ ...cardStyle, display:"flex", gap:16, flexWrap:"wrap" }}>
              {showDaily && <SummaryCard title="Today" s={summarize(daily)} />}
              {showWeekly && <SummaryCard title="This Week" s={summarize(weekly)} />}
            </section>
          )}

          <section style={cardStyle}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <h2 style={{ marginTop:0 }}>Active {periodFilter === "All" ? "(All Periods)" : `(Period ${periodFilter})`}</h2>
              <small style={{ color:"#6b7280" }}>Limit per destination: {OCC_LIMIT_PER_DEST}</small>
            </div>
            {!activeFiltered.length ? (
              <div style={{ color:"#6b7280" }}>No active passes.</div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Student</th><th style={th}>Destination</th><th style={th}>Started</th>
                    <th style={th}>Max</th><th style={th}>Elapsed</th><th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {activeFiltered.map((p) => {
                    const elapsed = fmtDuration(now() - p.startTime);
                    let liveOver = false;
                    if (p.maxMinutes) liveOver = ((now() - p.startTime) / 60000) > p.maxMinutes;
                    return (
                      <tr key={p.id} style={liveOver ? { background:"#fee2e2" } : null}>
                        <td style={td}>{p.student}</td>
                        <td style={td}>{p.destination}</td>
                        <td style={td}>{timeLocal(p.startTime)}</td>
                        <td style={td}>{p.maxMinutes ? `${p.maxMinutes} min` : "—"}</td>
                        <td style={td}><strong>{elapsed}</strong></td>
                        <td style={td}><button onClick={() => endPass(p.id)} style={btn}>End</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section style={cardStyle}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <h2 style={{ marginTop:0 }}>History {periodFilter === "All" ? "(All Periods)" : `(Period ${periodFilter})`}</h2>
              <button onClick={exportHistoryCSV} style={btn}>Download CSV</button>
            </div>
            <div style={{ color:"#6b7280" }}>History export uses your local cache (we can later store history in cloud too).</div>
          </section>
        </>
      )}

      {tab === "flyers" && (
        <section style={cardStyle}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <h2 style={{ marginTop:0 }}>Frequent Flyers {periodFilter === "All" ? "(All Periods)" : `(Period ${periodFilter})`}</h2>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <label style={lbl}>View Period</label>
              <select value={periodFilter} onChange={(e)=>setPeriodFilter(e.target.value)} style={selectStyle}>
                {["1","2","3","4","5","6","All"].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button onClick={exportFlyersCSV} style={btn}>Download CSV</button>
            </div>
          </div>
          {!flyersByPeriod.length ? (
            <div style={{ color:"#6b7280" }}>No flyer data yet.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Student</th><th style={th}>Passes</th><th style={th}>Avg (mm:ss)</th>
                  <th style={th}>Total (mm:ss)</th><th style={th}>Late</th><th style={th}>Late %</th><th style={th}>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {flyersByPeriod.map((s) => (
                  <tr key={s.name}>
                    <td style={td}>{s.name}</td>
                    <td style={td}>{s.count}</td>
                    <td style={td}>{toMMSS(s.avgMs)}</td>
                    <td style={td}>{toMMSS(s.totalMs)}</td>
                    <td style={td}>{s.late}</td>
                    <td style={td}>{s.latePct}</td>
                    <td style={td}>{s.lastSeen ? `${dateLocal(s.lastSeen)} ${timeLocal(s.lastSeen)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "roster" && (
        <section style={cardStyle}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <h2 style={{ marginTop:0 }}>Roster</h2>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <label style={lbl}>View Period</label>
              <select value={periodFilter} onChange={(e)=>setPeriodFilter(e.target.value)} style={selectStyle}>
                {["1","2","3","4","5","6"].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          <RosterTable
            roster={roster}
            period={periodFilter}
            startViaClick={(name) => {
              if (!adminMode) { showToast("Admin required to start pass from roster", "error"); return; }
              const ok = startPass({ student: name, dest: destination, period: Number(periodFilter), maxM: maxMinutes });
              if (ok) showToast(`Pass started for ${name} (P${periodFilter})`);
            }}
          />
        </section>
      )}

      {tab === "live" && (
        <LiveView active={active} />
      )}

      {toast.show && (
        <div style={{
          position:"fixed", bottom:20, right:20,
          background: toast.tone === "error" ? "#ef4444" : toast.tone === "info" ? "#3b82f6" : "#22c55e",
          color:"white", padding:"10px 16px", borderRadius:8, boxShadow:"0 4px 8px rgba(0,0,0,0.2)", fontWeight:600, zIndex:1000
        }}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

/* ===================== Presentational bits ===================== */
function LiveView({ active }) {
  const byDest = useMemo(() => {
    const m = new Map();
    for (const p of active) m.set(p.destination, (m.get(p.destination) || 0) + 1);
    return Array.from(m.entries()).sort((a,b) => b[1] - a[1]);
  }, [active]);

  return (
    <section style={cardStyle}>
      <h2 style={{ marginTop: 0 }}>Live Hallway Feed</h2>
      <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
        {byDest.map(([dest, count]) => (
          <div key={dest} style={{ border:"1px solid #e5e7eb", borderRadius:10, padding:12, minWidth:160 }}>
            <div style={{ fontSize:12, color:"#6b7280" }}>Destination</div>
            <div style={{ fontSize:20, fontWeight:800 }}>{dest}</div>
            <div style={{ marginTop:6 }}>Out now: <b>{count}</b></div>
          </div>
        ))}
        {!byDest.length && <div style={{ color:"#6b7280" }}>No active passes right now.</div>}
      </div>

      <div style={{ marginTop:16 }}>
        <b>Active Passes</b>
        {!active.length ? (
          <div style={{ color:"#6b7280" }}>—</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Student</th><th style={th}>Destination</th><th style={th}>Period</th><th style={th}>Started</th><th style={th}>Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                <tr key={p.id}>
                  <td style={td}>{p.student}</td>
                  <td style={td}>{p.destination}</td>
                  <td style={td}>{p.period}</td>
                  <td style={td}>{timeLocal(p.startTime)}</td>
                  <td style={td}><strong>{fmtDuration(now() - p.startTime)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function SummaryCard({ title, s }) {
  return (
    <div style={{ flex:"1 1 240px", border:"1px solid #e5e7eb", borderRadius:10, padding:12 }}>
      <h3 style={{ marginTop:0 }}>{title}</h3>
      <div style={{ display:"grid", gridTemplateColumns:"140px 1fr", rowGap:6 }}>
        <div style={sumLbl}>Avg time out</div><div><strong>{s.avgMin} min</strong></div>
        <div style={sumLbl}>Passes</div><div><strong>{s.count}</strong></div>
        <div style={sumLbl}>Late returns</div><div><strong>{s.late}</strong></div>
        <div style={sumLbl}>Busiest destination</div><div><strong>{s.busiest}</strong></div>
      </div>
    </div>
  );
}

function RosterTable({ roster, period, startViaClick }) {
  const rows = useMemo(() => {
    const arr = [];
    for (const [id, val] of Object.entries(roster || {})) {
      const p = Number(val?.period) || null;
      if (String(p) === String(period)) arr.push({ id, name: String(val?.name || ""), period: p });
    }
    return arr.sort((a, b) => a.name.localeCompare(b.name));
  }, [roster, period]);

  if (!rows.length) return <div style={{ color:"#6b7280" }}>No students for Period {period}.</div>;

  return (
    <table style={tableStyle}>
      <thead>
        <tr><th style={th}>Student</th><th style={th}>Student ID</th><th style={th}>Period</th><th style={th}></th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td style={td}>{r.name}</td>
            <td style={td}>{r.id}</td>
            <td style={td}>{r.period}</td>
            <td style={td}><button onClick={() => startViaClick(r.name)} style={btn}>Start Pass</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ===================== Styles ===================== */
const cardStyle = { background:"#fff", border:"1px solid #e5e7eb", borderRadius:10, padding:12, marginBottom:16 };
const tableStyle = { width:"100%", borderCollapse:"collapse" };
const th = { textAlign:"left", padding:"8px 6px", borderBottom:"1px solid #e5e7eb", fontWeight:700, fontSize:13 };
const td = { padding:"8px 6px", borderBottom:"1px solid #f3f4f6", fontSize:13 };
const btn = { padding:"6px 10px", borderRadius:8, border:"1px solid #d1d5db", background:"white", cursor:"pointer", fontWeight:600 };
const selectStyle = { padding:"6px 8px", borderRadius:8, border:"1px solid #d1d5db", background:"white" };
const inputStyle = { padding:"6px 8px", borderRadius:8, border:"1px solid #d1d5db" };
const lbl = { color:"#6b7280", fontSize:12 };
const sumLbl = { color:"#6b7280", fontSize:12 };
function tabBtnStyle(active) {
  return {
    padding:"8px 12px", borderRadius:999, border:"1px solid #d1d5db",
    background: active ? "#111827" : "white", color: active ? "white" : "#111827",
    cursor:"pointer", fontWeight:700
  };
}
