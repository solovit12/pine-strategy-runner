"""Open example: channel breakout with resting stop entries and a trailing stop.

Shows orders that wait inside the bar and execute in real time: the stop
entries sit at the channel edges and trigger when the live price breaks out.
"""

from psr_sdk import Param, Strategy
from psr_sdk.ta import highest, lowest


class ChannelBreakout(Strategy):
    name = "Channel breakout (example)"
    description = ("Buy-stop above the highest high and sell-stop below the lowest low of the last N bars "
                   "(one-cancels-other); the open trade is protected by a trailing stop.")
    timeframe = "1h"
    warmup_bars = 100
    params = {
        "length": Param(int, 20, min=2, max=500, label="Channel length, bars"),
        "trail_activation_ticks": Param(int, 200, min=1, label="Trail activation, ticks"),
        "trail_offset_ticks": Param(int, 100, min=1, label="Trail offset, ticks"),
        "stop_loss_ticks": Param(int, 300, min=1, label="Stop-loss, ticks"),
    }

    def on_bar(self, ctx, bar):
        p = ctx.params
        upper = highest([item.high for item in ctx.bars], p["length"])
        lower = lowest([item.low for item in ctx.bars], p["length"])
        if upper is None:
            return
        if ctx.position == 0:
            ctx.entry("BL", "long", stop=upper + ctx.mintick, oca="breakout")
            ctx.entry("BS", "short", stop=lower - ctx.mintick, oca="breakout")
        else:
            ctx.cancel("BL" if ctx.position > 0 else "BS")
        for entry in ("BL", "BS"):
            ctx.exit(f"X{entry}", entry, loss_ticks=p["stop_loss_ticks"],
                     trail_points_ticks=p["trail_activation_ticks"], trail_offset_ticks=p["trail_offset_ticks"])
