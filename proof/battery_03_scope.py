"""Battery 03 — scope isolation (pinned cognee==1.6.1, keyless route).

Probes how memory is isolated and scoped:
  1. dataset isolation: same query, different datasets -> disjoint evidence
  2. node_set tagging: node_name-filtered retrieval within one dataset
  3. multi-user isolation: two users, same dataset name (default-keyless posture)
Untested where the route needs an LLM or a server.
"""

import asyncio
import time

from battery_common import Record, stamp


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_03_scope")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    ql = open("data/quellight_like.txt", encoding="utf-8").read()
    tr = open("data/trading_like.txt", encoding="utf-8").read()

    # ---- 1. dataset isolation ----------------------------------------------
    await cognee.add(ql, dataset_name="alice_world")
    await cognee.add(tr, dataset_name="trader_world")
    await cognee.cognify(datasets=["alice_world", "trader_world"], extractor="gliner_demo")
    stamp("both isolated datasets cognified")

    t = time.perf_counter()
    r_ql = await cognee.search(
        query_text="weekly report", query_type=SearchType.CHUNKS, datasets=["alice_world"]
    )
    r_tr = await cognee.search(
        query_text="weekly report", query_type=SearchType.CHUNKS, datasets=["trader_world"]
    )
    rec.observe(
        "dataset isolation (CHUNKS 'weekly report')",
        "OBSERVED",
        {
            "alice_world_hits": len(r_ql),
            "trader_world_hits": len(r_tr),
            "note": "disjoint counts expected: content only exists in one dataset",
        },
        time.perf_counter() - t,
    )

    # no-datasets restriction: does search leak across datasets?
    t = time.perf_counter()
    try:
        r_all = await cognee.search(query_text="position size", query_type=SearchType.CHUNKS)
        rec.observe(
            "search without datasets arg (scope default)",
            "OBSERVED",
            {
                "count": len(r_all),
                "preview": repr(r_all[:1])[:200],
                "note": "does unrestricted search see every dataset for the user?",
            },
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "search without datasets arg", "EXPECTED-FAILURE", f"{type(e).__name__}: {str(e)[:200]}"
        )

    # ---- 2. node_set tagging ------------------------------------------------
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

    t = time.perf_counter()
    try:
        r_pref = await cognee.search(
            query_text="what does the user prefer",
            query_type=SearchType.CHUNKS,
            datasets=["tagged"],
            node_name=["preferences"],
        )
        r_all_tagged = await cognee.search(
            query_text="what does the user prefer", query_type=SearchType.CHUNKS, datasets=["tagged"]
        )
        rec.observe(
            "node_set scoping (node_name=['preferences'])",
            "OBSERVED",
            {
                "scoped_hits": len(r_pref),
                "unscoped_hits": len(r_all_tagged),
                "note": "scoped <= unscoped; scoped should exclude the incidents entry",
            },
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe("node_set scoping", "ERROR-UNEXPECTED", f"{type(e).__name__}: {e}")

    # ---- 3. multi-user isolation -------------------------------------------
    t = time.perf_counter()
    try:
        from cognee.modules.users.methods import get_default_user, create_user

        default_user = await get_default_user()
        try:
            user_b = await create_user(email="trader-b@proof.local", password="proof-password-123")
        except Exception as e:  # noqa: BLE001
            user_b = None
            rec.observe(
                "create_user (second principal)",
                "OBSERVED",
                f"create_user raised {type(e).__name__}: {str(e)[:200]}",
            )

        await cognee.add(
            "Secret note for user B only: the vault code is 4471.", dataset_name="userb_private",
            user=user_b,
        )
        await cognee.cognify(datasets=["userb_private"], user=user_b, extractor="gliner_demo")
        r_default = await cognee.search(
            query_text="vault code", query_type=SearchType.CHUNKS, datasets=["userb_private"]
        )
        r_b = await cognee.search(
            query_text="vault code", query_type=SearchType.CHUNKS, datasets=["userb_private"],
            user=user_b,
        )
        rec.observe(
            "user isolation (default user vs user B on userb_private)",
            "OBSERVED",
            {
                "default_user_hits": len(r_default),
                "user_b_hits": len(r_b),
                "note": "default user should NOT see user B's dataset",
            },
        )
    except Exception as e:  # noqa: BLE001
        rec.observe("user isolation", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:300]}")

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
