# NDA4 Solana Memecoin Scanner v2

AI-powered Solana memecoin paper trading bot with GMGN on-chain intelligence.

## Features
- **GMGN Integration**: Trending tokens + Trenches (new pump.fun launches)
- **AI Analysis**: OpenRouter (OWL Alpha) decides entry/TP/SL
- **Paper Trading**: 0.03 SOL per trade, 1 SOL balance
- **Auto-improve**: Filters evolve after consecutive losses
- **Telegram Notifications**: Entry/SL/TP alerts

## Setup

1. Clone repo
2. Copy `.env.example` to `.env` and fill in your keys:
   ```bash
   cp .env.example .env
   nano .env
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   npm install -g gmgn-cli
   ```
4. Configure GMGN API key:
   ```bash
   mkdir -p ~/.config/gmgn
   echo 'GMGN_API_KEY=your_key' > ~/.config/gmgn/.env
   ```
5. Run:
   ```bash
   python3 bot.py
   ```

## Config
| Env Var | Default | Description |
|---------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your chat ID |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `GMGN_API_KEY` | — | GMGN API key |
| `PAPER_TRADE` | `true` | Set `false` for live trading |
| `TRADE_SIZE` | `0.03` | SOL per trade |
| `MAX_OPEN_TRADES` | `10` | Max concurrent positions |

## Disclaimer
Paper trading only. Use at your own risk.
