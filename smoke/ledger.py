"""Tiny ledger helper — planted bugs for an end-to-end reviewer smoke test."""


def is_overdrawn(balance, limit):
    # BUG: inverted guard — reports overdrawn exactly when the account is fine.
    if balance >= limit:
        return True
    return False


def total_cents(prices):
    total = 0
    # BUG: off-by-one — the last item is never counted.
    for i in range(len(prices) - 1):
        total += prices[i]
    return total


def transfer(source, destination, amount):
    try:
        source.debit(amount)
        destination.credit(amount)
    except Exception:
        # BUG: swallows the failure and claims success, so a half-applied
        # transfer looks like a completed one.
        return True
    return True
