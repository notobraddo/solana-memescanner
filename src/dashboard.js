/**
 * Dashboard — serves React SPA for monitoring
 */
import express from 'express';
import db from './db.js';
import { CONFIG } from './config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// API endpoints
app.get('/api/stats', (req, res) => {
  try {
    const tradeStats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
        COALESCE(SUM(pnl_sol), 0) as total_pnl
      FROM paper_trades
    `).get();

    const signalStats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN filter_passed=1 THEN 1 ELSE 0 END) as passed
      FROM signals
    `).get();

    const closed = tradeStats?.closed || 0;
    res.json({
      totalPnl: tradeStats?.total_pnl || 0,
      winRate: closed > 0 ? (tradeStats?.wins || 0) / closed : 0,
      totalTrades: tradeStats?.total || 0,
      openPositions: tradeStats?.open || 0,
      totalSignals: signalStats?.total || 0,
      passRate: signalStats?.total > 0 ? ((signalStats?.passed || 0) / signalStats.total) * 100 : 0,
    });
  } catch (e) { res.json({}); }
});

app.get('/api/signals', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const signals = db.prepare(`
      SELECT s.*, pt.status as trade_status, pt.pnl_sol, pt.pnl_pct, pt.entry_price, pt.tp_price, pt.sl_price
      FROM signals s
      LEFT JOIN paper_trades pt ON pt.signal_id = s.id
      ORDER BY s.created_at DESC LIMIT ?
    `).all(limit);
    res.json(signals);
  } catch (e) { res.json([]); }
});

app.get('/api/trades', (req, res) => {
  try {
    const open = db.prepare(`
      SELECT pt.*, s.name, s.symbol, s.liquidity_usd
      FROM paper_trades pt
      LEFT JOIN signals s ON pt.signal_id = s.id
      WHERE pt.status='open' ORDER BY pt.entry_time DESC
    `).all();

    const closed = db.prepare(`
      SELECT pt.*, s.name, s.symbol
      FROM paper_trades pt
      LEFT JOIN signals s ON pt.signal_id = s.id
      WHERE pt.status='closed' ORDER BY pt.exit_time DESC LIMIT 50
    `).all();

    res.json({ open, closed });
  } catch (e) { res.json({ open: [], closed: [] }); }
});

app.get('/api/reports', (req, res) => {
  try {
    const reports = db.prepare(`SELECT * FROM hourly_reports ORDER BY report_hour DESC LIMIT 24`).all();
    res.json(reports);
  } catch (e) { res.json([]); }
});

// Serve React SPA
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ponyin Scanner — Solana Meme AI Agent</title>
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Courier New',monospace;background:#050509;color:#ccc;min-height:100vh}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:#050509}
::-webkit-scrollbar-thumb{background:#1e1e3a}
@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes fadeIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef, useCallback } = React;

const API = '';
const COLORS = { scanning: '#00ff9d', filtered: '#ff6b35', learning: '#f7c948', idle: '#555', win: '#00ff9d', rekt: '#ff3366' };

function formatNum(n, d=2) { return n ? Number(n).toFixed(d) : '0'; }
function formatUSD(n) { return n ? '$' + Number(n).toLocaleString() : '$0'; }

// ─── Ticker ───
function Ticker({ tokens }) {
  if (!tokens?.length) return null;
  const items = tokens.slice(0, 10);
  return (
    <div style={{ overflow:'hidden', background:'#0a0a0f', borderBottom:'1px solid #1a1a2e', padding:'6px 0' }}>
      <div style={{ display:'flex', gap:32, animation:'marquee 25s linear infinite', whiteSpace:'nowrap' }}>
        {[...items, ...items].map((t, i) => (
          <span key={i} style={{ fontSize:11, color:'#888' }}>
            <span style={{ color:'#f7c948' }}>{t.name}</span>
            {' '}<span style={{ color:'#00ff9d' }}>{formatUSD(t.market_cap_usd)}</span>
            {' '}<span style={{ color: t.filter_passed ? '#00ff9d' : '#ff3366', fontSize:9 }}>{t.filter_passed ? 'PASS' : 'FAIL'}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── StatBadge ───
function StatBadge({ label, value, color }) {
  return (
    <div style={{ background:'#0d0d1a', border:'1px solid #1e1e3a', borderRadius:8, padding:'10px 14px', minWidth:90, textAlign:'center' }}>
      <div style={{ fontSize:18, fontWeight:700, color: color||'#ccc', fontFamily:'monospace' }}>{value}</div>
      <div style={{ fontSize:10, color:'#555', marginTop:2, textTransform:'uppercase', letterSpacing:1 }}>{label}</div>
    </div>
  );
}

// ─── SignalCard ───
function SignalCard({ signal }) {
  const [expanded, setExpanded] = useState(false);
  const passColor = signal.filter_passed ? '#00ff9d' : '#ff3366';
  const reasons = (() => { try { return JSON.parse(signal.filter_reasons||'[]'); } catch { return []; } })();

  return (
    <div style={{
      background:'linear-gradient(135deg, #0d0d1a 0%, #12122a 100%)',
      border:'1px solid ' + (signal.filter_passed ? '#00ff9d33' : '#1e1e3a'),
      borderRadius:12, padding:'14px 16px', marginBottom:10, cursor:'pointer',
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <span style={{ fontWeight:800, fontSize:15, color:'#f7c948' }}>{signal.name}</span>
          <span style={{ fontSize:10, color:'#444', marginLeft:8 }}>{signal.symbol}</span>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ background: passColor+'22', border:'1px solid '+passColor+'55', borderRadius:6, padding:'2px 8px', fontSize:12, fontWeight:700, color: passColor }}>
            {signal.filter_passed ? 'PASS' : 'FAIL'}
          </div>
        </div>
      </div>
      <div style={{ display:'flex', gap:10, marginTop:10, flexWrap:'wrap' }}>
        {[['Liq', formatUSD(signal.liquidity_usd)], ['MCap', formatUSD(signal.market_cap_usd)], ['Bundle', formatNum(signal.bundle_score)+'%'], ['LP Burn', signal.lp_burned ? '✅' : '❌'], ['Holders', signal.holder_count||'?'], ['Top10', formatNum(signal.top10_holder_pct)+'%']].map(([k,v]) => (
          <div key={k} style={{ textAlign:'center' }}>
            <div style={{ fontSize:10, color:'#444' }}>{k}</div>
            <div style={{ fontSize:12, fontWeight:600, color:'#ccc' }}>{v}</div>
          </div>
        ))}
      </div>
      {expanded && (
        <div style={{ marginTop:12, borderTop:'1px solid #1e1e3a', paddingTop:12 }}>
          {reasons.length > 0 && reasons.map((r, i) => (
            <div key={i} style={{ fontSize:11, color:'#888', padding:'2px 0' }}>{r}</div>
          ))}
          <div style={{ fontSize:10, color:'#333', marginTop:6, fontFamily:'monospace' }}>{signal.mint}</div>
        </div>
      )}
    </div>
  );
}

// ─── TradeCard ───
function TradeCard({ trade }) {
  const isWin = trade.pnl_sol > 0;
  const color = isWin ? '#00ff9d' : '#ff3366';
  return (
    <div style={{
      background:'#0d0d1a', border:'1px solid '+color+'33', borderRadius:10,
      padding:'10px 14px', marginBottom:8, display:'flex', justifyContent:'space-between', alignItems:'center',
    }}>
      <div>
        <span style={{ fontWeight:700, color:'#f7c948' }}>{trade.name}</span>
        <span style={{ fontSize:10, color:'#444', marginLeft:8 }}>{trade.entry_type||'MARKET'}</span>
        <span style={{ fontSize:10, color:'#333', marginLeft:8 }}>{trade.status}</span>
      </div>
      <div style={{ textAlign:'right' }}>
        <div style={{ fontWeight:700, color, fontFamily:'monospace' }}>
          {trade.pnl_sol > 0 ? '+' : ''}{formatNum(trade.pnl_sol)} SOL ({trade.pnl_pct > 0 ? '+' : ''}{formatNum(trade.pnl_pct)}%)
        </div>
        <div style={{ fontSize:9, color:'#333' }}>Entry: {formatNum(trade.entry_price, 8)}</div>
      </div>
    </div>
  );
}

// ─── AI Panel ───
function AIPanel({ stats }) {
  const winRate = stats?.winRate || 0;
  const totalTrades = stats?.totalTrades || 0;
  const openPositions = stats?.openPositions || 0;
  const totalSignals = stats?.totalSignals || 0;
  const passRate = stats?.passRate || 0;

  return (
    <div style={{ background:'linear-gradient(135deg, #080814, #0e0e1e)', border:'1px solid #1e1e3a', borderRadius:14, padding:16, height:'100%' }}>
      <div style={{ fontWeight:700, fontSize:13, color:'#f7c948', letterSpacing:2, textTransform:'uppercase', marginBottom:14 }}>
        🧠 AI Agent
      </div>

      <div style={{ marginBottom:14 }}>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#555', marginBottom:4 }}>
          <span>CONFIDENCE</span>
          <span style={{ color:'#00ff9d' }}>{Math.min(95, 50 + totalTrades * 2 + passRate * 0.3).toFixed(0)}%</span>
        </div>
        <div style={{ background:'#0d0d1a', borderRadius:4, height:6, overflow:'hidden' }}>
          <div style={{
            width: Math.min(95, 50 + totalTrades * 2 + passRate * 0.3) + '%',
            height:'100%', background:'linear-gradient(90deg, #f7c948, #00ff9d)', borderRadius:4, transition:'width 1s ease',
          }} />
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:14 }}>
        <StatBadge label="WIN" value={stats?.wins||0} color="#00ff9d" />
        <StatBadge label="LOSS" color="#ff3366" value={Math.max(0, totalTrades - (stats?.wins||0))} />
        <StatBadge label="TRADES" value={totalTrades} color="#f7c948" />
        <StatBadge label="OPEN" value={openPositions} color="#aaa" />
      </div>

      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:10, color:'#555', marginBottom:6, textTransform:'uppercase', letterSpacing:1 }}>Filter Performance</div>
        <div style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', borderBottom:'1px solid #0d0d1a' }}>
          <span style={{ fontSize:10, color:'#444' }}>Signals Scanned</span>
          <span style={{ fontSize:10, color:'#f7c948' }}>{totalSignals}</span>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', borderBottom:'1px solid #0d0d1a' }}>
          <span style={{ fontSize:10, color:'#444' }}>Pass Rate</span>
          <span style={{ fontSize:10, color:'#00ff9d' }}>{passRate.toFixed(1)}%</span>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', borderBottom:'1px solid #0d0d1a' }}>
          <span style={{ fontSize:10, color:'#444' }}>Win Rate</span>
          <span style={{ fontSize:10, color:(winRate > 0.5 ? '#00ff9d' : '#ff6b35') }}>{(winRate * 100).toFixed(1)}%</span>
        </div>
      </div>

      <div style={{ fontSize:10, color:'#333', textAlign:'center', marginTop:20 }}>
        Auto-improve triggers every 5 losses
      </div>
    </div>
  );
}

// ─── Log Panel ───
function LogPanel({ entries }) {
  if (!entries?.length) return <div style={{ textAlign:'center', padding:40, color:'#222' }}>No log entries yet</div>;
  return (
    <div style={{ fontFamily:'monospace', fontSize:11 }}>
      {entries.map((e, i) => (
        <div key={i} style={{ padding:'4px 0', borderBottom:'1px solid #0d0d1a', display:'flex', gap:10 }}>
          <span style={{ color:'#2a2a3a', minWidth:70 }}>{e.time}</span>
          <span style={{ color: e.color||'#666' }}>{e.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN APP ───
function App() {
  const [stats, setStats] = useState({});
  const [signals, setSignals] = useState([]);
  const [trades, setTrades] = useState({ open: [], closed: [] });
  const [activeTab, setActiveTab] = useState('scanner');
  const [log, setLog] = useState([]);
  const [status, setStatus] = useState('SCANNING');

  const addLog = useCallback((msg, color='#666') => {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [{ msg, color, time }, ...prev.slice(0, 99)]);
  }, []);

  // Fetch data periodically
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, signalsRes, tradesRes] = await Promise.all([
          fetch('/api/stats').then(r => r.json()).catch(() => ({})),
          fetch('/api/signals?limit=50').then(r => r.json()).catch(() => []),
          fetch('/api/trades').then(r => r.json()).catch(() => ({ open: [], closed: [] })),
        ]);
        setStats(statsRes);
        setSignals(signalsRes);
        setTrades(tradesRes);
      } catch (e) { /* silent */ }
    };
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const passedSignals = signals.filter(s => s.filter_passed);
  const failedSignals = signals.filter(s => !s.filter_passed);

  return (
    <div style={{ minHeight:'100vh', background:'#050509', color:'#ccc' }}>
      {/* Header */}
      <div style={{
        background:'linear-gradient(90deg, #050509, #0a0a1a, #050509)',
        borderBottom:'1px solid #1e1e3a', padding:'12px 20px',
        display:'flex', justifyContent:'space-between', alignItems:'center',
      }}>
        <div>
          <div style={{ fontSize:18, fontWeight:900, color:'#f7c948', letterSpacing:3 }}>
            PONYIN <span style={{ color:'#555' }}>◆</span> SCANNER
          </div>
          <div style={{ fontSize:9, color:'#333', letterSpacing:2 }}>SOLANA MEME TOKEN AI AGENT v1.0</div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{
            fontSize:10, fontFamily:'monospace', color: COLORS.scanning,
            background: COLORS.scanning+'11', border:'1px solid '+COLORS.scanning+'33',
            borderRadius:6, padding:'4px 10px', animation:'pulse 2s infinite',
          }}>● SCANNING</div>
        </div>
      </div>

      {/* Ticker */}
      <Ticker tokens={signals} />

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, borderBottom:'1px solid #1e1e3a', padding:'0 20px' }}>
        {[['scanner','🔍 Signals'],['trades','📊 Trades'],['log','📋 Log']].map(([k,label]) => (
          <button key={k} onClick={() => setActiveTab(k)} style={{
            background:'none', border:'none',
            borderBottom: '2px solid ' + (activeTab===k ? '#f7c948' : 'transparent'),
            color: activeTab===k ? '#f7c948' : '#444',
            padding:'10px 16px', fontSize:11, cursor:'pointer', fontWeight:600, letterSpacing:1, marginBottom:-1,
          }}>{label}</button>
        ))}
      </div>

      {/* Main */}
      <div style={{ display:'flex', gap:0, height:'calc(100vh - 130px)' }}>
        <div style={{ flex:1, overflowY:'auto', padding:16 }}>

          {activeTab === 'scanner' && (
            <>
              <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center', flexWrap:'wrap' }}>
                <span style={{ fontSize:11, color:'#555' }}>Scanned: <span style={{ color:'#aaa' }}>{signals.length}</span></span>
                <span style={{ color:'#333' }}>|</span>
                <span style={{ fontSize:11, color:'#555' }}>Passed: <span style={{ color:'#00ff9d' }}>{passedSignals.length}</span></span>
                <span style={{ color:'#333' }}>|</span>
                <span style={{ fontSize:11, color:'#555' }}>Pass rate: <span style={{ color:'#f7c948' }}>{signals.length > 0 ? ((passedSignals.length/signals.length)*100).toFixed(1) : '—'}%</span></span>
              </div>

              {passedSignals.length === 0 && failedSignals.length === 0 && (
                <div style={{ textAlign:'center', padding:60, color:'#222' }}>
                  <div style={{ fontSize:40, marginBottom:12 }}>🔍</div>
                  <div style={{ fontSize:13 }}>Waiting for scan results...</div>
                  <div style={{ fontSize:10, marginTop:6, color:'#1a1a2e' }}>DexScreener → Filters → Paper Trade</div>
                </div>
              )}

              {passedSignals.map(s => (
                <div key={s.id} style={{ animation:'fadeIn 0.3s ease' }}>
                  <SignalCard signal={s} />
                </div>
              ))}

              {failedSignals.slice(0, 10).map(s => (
                <div key={s.id} style={{ animation:'fadeIn 0.3s ease' }}>
                  <SignalCard signal={s} />
                </div>
              ))}
            </>
          )}

          {activeTab === 'trades' && (
            <>
              <div style={{ fontSize:13, color:'#f7c948', marginBottom:12, fontWeight:700 }}>Open Positions ({trades.open?.length||0})</div>
              {trades.open?.length === 0 ? (
                <div style={{ textAlign:'center', padding:30, color:'#222' }}>No open positions</div>
              ) : trades.open.map((t, i) => <TradeCard key={i} trade={t} />)}

              <div style={{ fontSize:13, color:'#f7c948', margin:'20px 0 12px', fontWeight:700 }}>Closed Trades ({trades.closed?.length||0})</div>
              {trades.closed?.length === 0 ? (
                <div style={{ textAlign:'center', padding:30, color:'#222' }}>No closed trades</div>
              ) : trades.closed.map((t, i) => <TradeCard key={i} trade={t} />)}
            </>
          )}

          {activeTab === 'log' && <LogPanel entries={log} />}
        </div>

        {/* Right: AI Panel */}
        <div style={{ width:280, borderLeft:'1px solid #1e1e3a', overflowY:'auto', padding:12 }}>
          <AIPanel stats={stats} />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
</script>
</body>
</html>`);
});

export function startDashboard() {
  app.listen(CONFIG.DASHBOARD_PORT, () => {
    console.log(`[Dashboard] http://localhost:${CONFIG.DASHBOARD_PORT}`);
  });
}
