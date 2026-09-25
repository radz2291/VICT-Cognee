"""Battery 03b — scope isolation, corrected (pinned cognee==1.6.1, keyless route).

Fixes vs battery_03:
  - create_user with a routable email domain (proof.local was rejected as a
    reserved special-use name by pydantic email validation)
  - identity-based comparison (chunk ids) instead of hit counts
  - node_set probe compares which text came back
"""

import asyncio
import time

from battery_common import Record, stamp


def hit_ids(result) -> list[str]:
    ids = []
    for r in result or []:
        sr = r.get("search_result") if isinstance(r, dict) else None
        for item in sr or []:
            i = item.get("id") if isinstance(item, dict) else None
            if i:
                ids.append(str(i))
    return ids


def hit_texts(result) -> list[str]:
    out = []
    for r in result or []:
        sr = r.get("search_result") if isinstance(r, dict) else None
        for item in sr or []:
            t = item.get("text") if isinstance(item, dict) else None
            if t:
                out.append(str(t)[:80])
    return out


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_03b_scope")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    ql = open("data/quellight_like.txt", encoding="utf-8").read()
    tr = open("data/trading_like.txt", encoding="utf-8").read()

    await cognee.add(ql, dataset_name="alice_world")
    await cognee.add(tr, dataset_name="trader_world")
    await cognee.cognify(datasets=["alice_world", "trader_world"], extractor="gliner_demo")
    stamp("isolated datasets cognified")

    # ---- 1. dataset isolation with identity comparison ----------------------
    r_ql = await cognee.search(
        query_text="weekly report deadline", query_type=SearchType.CHUNKS, datasets=["alice_world"]
    )
    r_tr = await cognee.search(
        query_text="weekly report deadline", query_type=SearchType.CHUNKS, datasets=["trader_world"]
    )
    ids_ql, ids_tr = hit_ids(r_ql), hit_ids(r_tr)
    overlap = set(ids_ql) & set(ids_tr)
    rec.observe(
        "dataset isolation (identity overlap)",
        "OBSERVED",
        {
            "alice_ids": ids_ql[:4],
            "trader_ids": ids_tr[:4],
            "overlap": len(overlap),
            "trader_texts": hit_texts(r_tr)[:3],
            "note": "overlap must be 0; trader_texts shows whether the trader hit is a "
            "genuine match or a zero-similarity fallback (BM25/vector top-k without threshold)",
        },
    )

    # cross-scope query: something that only exists in trader_world
    r_only_tr = await cognee.search(
        query_text="FOMC entry rule", query_type=SearchType.CHUNKS, datasets=["alice_world"]
    )
    rec.observe(
        "scoped query for trader-only content inside alice_world",
        "OBSERVED",
        {"alice_ids": hit_ids(r_only_tr)[:4], "texts": hit_texts(r_only_tr)[:2],
         "note": "does alice_world return trader content it does not contain?"},
    )

    # ---- default scope when datasets arg omitted ----------------------------
    r_all = await cognee.search(query_text="position size", query_type=SearchType.CHUNKS)
    ds_seen = sorted({r.get("dataset_name") for r in r_all if isinstance(r, dict)})
    rec.observe(
        "search without datasets arg (default scope)",
        "OBSERVED",
        {"datasets_seen": ds_seen, "count": len(r_all),
         "note": "expected: all datasets visible to the calling user"},
    )

    # ---- 2. node_set tagging with text evidence ------------------------------
    await cognee.add(
        "Tagged memory A: the user prefers dark mode in all dashboards.",
        dataset_name="tagged",
        node_set=["preferences"],
    )
    await cognee.add(
        "Tagged memory B: incident postmortem filed for checkout outage.",
        dataset_name="tagged",
        node_set=["incidents"],
    )
    await cognee.cognify(datasets=["tagged"], extractor="gliner_demo")
    stamp("tagged dataset cognified")

    r_pref = await cognee.search(
        query_text="dashboard theme preference",
        query_type=SearchType.CHUNKS,
        datasets=["tagged"],
        node_name=["preferences"],
    )
    r_inc = await cognee.search(
        query_text="dashboard theme preference",
        query_type=SearchType.CHUNKS,
        datasets=["tagged"],
        node_name=["incidents"],
    )
    r_unscoped = await cognee.search(
        query_text="dashboard theme preference", query_type=SearchType.CHUNKS, datasets=["tagged"]
    )
    rec.observe(
        "node_set scoping (identity + text)",
        "OBSERVED",
        {
            "preferences_ids": hit_ids(r_pref)[:3],
            "incidents_ids": hit_ids(r_inc)[:3],
            "unscoped_ids": hit_ids(r_unscoped)[:3],
            "preferences_texts": hit_texts(r_pref)[:2],
            "incidents_texts": hit_texts(r_inc)[:2],
            "note": "scoped results should differ by node_name filter",
        },
    )

    # ---- 3. multi-user isolation (fixed email) --------------------------------
    try:
        from cognee.modules.users.methods import get_default_user, create_user

        default_user = await get_default_user()
        rec.observe("default user", "OBSERVED", {"id": str(getattr(default_user, "id", "?"))[:8],
                                                 "email": str(getattr(default_user, "email", "?"))})
        user_b = None
        try:
            user_b = await create_user(email="trader-b@example.com", password="proof-password-123")
            rec.observe("create_user(trader-b@example.com)", "OBSERVED",
                        {"id": str(getattr(user_b, "id", "?"))[:8]})
        except Exception as e:  # noqa: BLE001
            rec.observe("create_user", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:250]}")

        if user_b is not None:
            await cognee.add(
                "Secret note for user B only: the vault code is 4471.",
                dataset_name="userb_private", user=user_b,
            )
            await cognee.cognify(datasets=["userb_private"], user=user_b, extractor="gliner_demo")
            stamp("userb_private cognified as user B")

            r_default = await cognee.search(
                query_text="vault code", query_type=SearchType.CHUNKS, datasets=["userb_private"]
            )
            r_b = await cognee.search(
                query_text="vault code", query_type=SearchType.CHUNKS, datasets=["userb_private"],
                user=user_b,
            )
            rec.observe(
                "user isolation on userb_private",
                "OBSERVED",
                {
                    "default_user_ids": hit_ids(r_default)[:3],
                    "user_b_ids": hit_ids(r_b)[:3],
                    "default_user_texts": hit_texts(r_default)[:2],
                    "user_b_texts": hit_texts(r_b)[:2],
                    "note": "default user must NOT see user B's dataset",
                },
            )
    except Exception as e:  # noqa: BLE001
        rec.observe("user isolation", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:300]}")

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
