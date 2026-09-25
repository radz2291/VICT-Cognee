"""Follow-up: complete the user-B isolation probe (both legs, error-contained)."""

import asyncio

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

    rec = Record("battery_03c_userb")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    from cognee.modules.engine.operations.setup import setup
    from cognee.modules.users.methods import create_user, get_default_user

    # OBSERVED: prune_system(metadata=True) drops the relational layer; setup()
    # must run again before any user operation (matches the documented
    # "prune is full test teardown" caveat).
    await setup()
    default_user = await get_default_user()
    user_b = await create_user(email="trader-b@example.com", password="proof-password-123")
    rec.observe(
        "principals",
        "OBSERVED",
        {"default": str(getattr(default_user, "id", "?"))[:8], "user_b": str(getattr(user_b, "id", "?"))[:8]},
    )

    # user B owns a private dataset
    await cognee.add(
        "Secret note for user B only: the vault code is 4471.",
        dataset_name="userb_private",
        user=user_b,
    )
    await cognee.cognify(datasets=["userb_private"], user=user_b, extractor="gliner_demo")
    stamp("userb_private cognified as user B")

    # default user tries the dataset by NAME
    try:
        r_default = await cognee.search(
            query_text="vault code", query_type=SearchType.CHUNKS, datasets=["userb_private"]
        )
        rec.observe(
            "default user -> userb_private by name",
            "OBSERVED",
            {"ids": hit_ids(r_default)[:3], "texts": hit_texts(r_default)[:2]},
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "default user -> userb_private by name",
            "EXPECTED-FAILURE",
            f"{type(e).__name__}: {str(e)[:220]}",
        )

    # default user searches EVERYTHING it owns (no datasets arg) — no leak?
    r_all = await cognee.search(query_text="vault code", query_type=SearchType.CHUNKS)
    rec.observe(
        "default user -> unrestricted search for user-B secret",
        "OBSERVED",
        {"ids": hit_ids(r_all)[:3], "texts": hit_texts(r_all)[:2],
         "datasets_seen": sorted({r.get("dataset_name") for r in r_all if isinstance(r, dict)})},
    )

    # owner reads its own dataset
    r_b = await cognee.search(
        query_text="vault code", query_type=SearchType.CHUNKS, datasets=["userb_private"],
        user=user_b,
    )
    rec.observe(
        "user B -> own dataset",
        "OBSERVED",
        {"ids": hit_ids(r_b)[:3], "texts": hit_texts(r_b)[:2]},
    )

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
