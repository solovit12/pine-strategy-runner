"""Small indicator helpers over sequences of floats (oldest first).

They return the latest value (or None until enough data) and are plain Python,
so strategies stay dependency-free. For heavy work use numpy in your own pack.
"""

import math


def sma(values, length):
    values = list(values)[-length:]
    return sum(values) / length if len(values) == length else None


def ema(values, length):
    values = list(values)
    if len(values) < length:
        return None
    alpha = 2 / (length + 1)
    result = sum(values[:length]) / length
    for value in values[length:]:
        result += alpha * (value - result)
    return result


def rsi(values, length=14):
    values = list(values)
    if len(values) <= length:
        return None
    gains = losses = 0.0
    for previous, current in zip(values[:length], values[1:length + 1]):
        change = current - previous
        gains += max(change, 0)
        losses += max(-change, 0)
    average_gain, average_loss = gains / length, losses / length
    for previous, current in zip(values[length:], values[length + 1:]):
        change = current - previous
        average_gain = (average_gain * (length - 1) + max(change, 0)) / length
        average_loss = (average_loss * (length - 1) + max(-change, 0)) / length
    if average_loss == 0:
        return 100.0
    return 100 - 100 / (1 + average_gain / average_loss)


def atr(bars, length=14):
    bars = list(bars)
    if len(bars) <= length:
        return None
    ranges = [max(bar.high - bar.low, abs(bar.high - previous.close), abs(bar.low - previous.close))
              for previous, bar in zip(bars, bars[1:])]
    result = sum(ranges[:length]) / length
    for value in ranges[length:]:
        result = (result * (length - 1) + value) / length
    return result


def highest(values, length):
    values = list(values)[-length:]
    return max(values) if len(values) == length else None


def lowest(values, length):
    values = list(values)[-length:]
    return min(values) if len(values) == length else None


def crossover(fast_now, fast_before, slow_now, slow_before):
    if None in (fast_now, fast_before, slow_now, slow_before) or any(map(math.isnan, (fast_now, fast_before, slow_now, slow_before))):
        return False
    return fast_before <= slow_before and fast_now > slow_now


def crossunder(fast_now, fast_before, slow_now, slow_before):
    return crossover(slow_now, slow_before, fast_now, fast_before)
