"""Open example: EMA crossover with take-profit and stop-loss in ticks."""

from psr_sdk import Param, Strategy
from psr_sdk.ta import crossover, crossunder, ema


class EmaCross(Strategy):
    name = "EMA cross (example)"
    description = ("Long when the fast EMA crosses above the slow EMA, short on the opposite cross. "
                   "Every trade gets a take-profit and a stop-loss measured from its real entry price.")
    timeframe = "15m"
    warmup_bars = 300
    params = {
        "fast": Param(int, 12, min=2, max=200, label="Fast EMA"),
        "slow": Param(int, 26, min=3, max=500, label="Slow EMA"),
        "take_profit_ticks": Param(int, 300, min=1, label="Take-profit, ticks"),
        "stop_loss_ticks": Param(int, 150, min=1, label="Stop-loss, ticks"),
    }

    def on_bar(self, ctx, bar):
        closes = [item.close for item in ctx.bars]
        p = ctx.params
        fast_now, slow_now = ema(closes, p["fast"]), ema(closes, p["slow"])
        fast_before, slow_before = ema(closes[:-1], p["fast"]), ema(closes[:-1], p["slow"])
        if crossover(fast_now, fast_before, slow_now, slow_before):
            ctx.entry("L", "long")
        elif crossunder(fast_now, fast_before, slow_now, slow_before):
            ctx.entry("S", "short")
        ctx.exit("XL", "L", profit_ticks=p["take_profit_ticks"], loss_ticks=p["stop_loss_ticks"])
        ctx.exit("XS", "S", profit_ticks=p["take_profit_ticks"], loss_ticks=p["stop_loss_ticks"])
