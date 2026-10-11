"""Bounded exact-decimal observations; never changes a book or trading gate."""

from decimal import Decimal


def book_state(book):
    if book is None:
        return {"invalid": "missing_book"}
    bids, asks = book.bids(), book.asks()
    invalid = ("empty_both" if not bids and not asks else "empty_bid" if not bids else
               "empty_ask" if not asks else "locked" if bids[0].price == asks[0].price else
               "crossed" if bids[0].price > asks[0].price else None)
    def levels(rows):
        return [[str(level.price), format(sum((order.size.as_decimal() for order in level.get_orders()), Decimal(0)), "f")]
                for level in rows[:5]]
    return {"invalid": invalid, "sequence": book.sequence, "tsLastNs": book.ts_last,
            "updates": book.update_count, "bidLevels": len(bids), "askLevels": len(asks),
            "depthLimit": 5, "bids": levels(bids), "asks": levels(asks)}


def batch_state(batch):
    # A summary of the entire batch, plus exact first four operations. Counts
    # explicitly distinguish this bounded sample from a raw-depth archive.
    counts = {}
    for delta in batch.deltas:
        action = str(delta.action).split(".")[-1]
        counts[action] = counts.get(action, 0) + 1
    return {"sequence": batch.sequence, "sourceNs": batch.ts_event, "initNs": batch.ts_init,
            "deltaCount": len(batch.deltas), "actions": counts,
            "sampleLimit": 4, "sample": [
                {"action": str(d.action).split(".")[-1], "side": str(d.order.side).split(".")[-1],
                 "price": str(d.order.price), "size": str(d.order.size), "flags": int(d.flags)}
                for d in batch.deltas[:4]]}


def quote_state(quote):
    if quote is None:
        return None
    return {"bid": str(quote.bid_price), "ask": str(quote.ask_price),
            "bidSize": str(quote.bid_size), "askSize": str(quote.ask_size),
            "sourceNs": quote.ts_event, "initNs": quote.ts_init}
