# Polymarket Pro Terminal

Local-only paper execution terminal for the hedged-bias strategy:

- scans active Polymarket books
- watches recent wallet flow
- finds two-sided paper hedge setups near 100-105c total cost
- persists paper cash and open positions across restarts
- exposes manual paper execution buttons
- logs every paper open, close, and settle event

This is paper trading software. It does not place real orders.

## Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8788
```

## Settings

Use environment variables:

```bash
PORT=8788 \
PAPER_BANKROLL=1000 \
MAX_STAKE=50 \
MAX_END_HOURS=24 \
HEDGE_MIN_COST=1.00 \
HEDGE_MAX_COST=1.05 \
MIN_NET_CASH=100 \
MIN_TRADE_EDGE=1 \
SCAN_INTERVAL_MS=12000 \
npm start
```

## Files

Runtime files are created under `data/`:

- `paper-state.json` - current paper cash and open/closed positions
- `paper-trades.ndjson` - audit log of manual/auto paper actions
- `snapshots.ndjson` - scan snapshots

## Manual Execution

The dashboard supports:

- paper-open best signal
- close position at current bid marks
- manually settle a position by selecting the winning outcome

Manual settle is needed because Polymarket resolution can lag and inactive markets may have no bids. Until settlement is known, mark-to-market is only an estimate.

## Risk

This is not arbitrage unless the math guarantees payoff in all outcomes after execution, fees, slippage, and resolution risk. This strategy is a hedged directional strategy, not free money.
