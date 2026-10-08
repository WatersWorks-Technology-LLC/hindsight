# Candidate source evidence

`HINDSIGHT_API_SOURCE_QUOTE_INSIGHTS=1` opts consolidation into source-only evidence candidates. Normal consolidation is unchanged when unset. Preserve the existing provider and credential configuration; this contribution chooses neither a provider nor a model.

The model proposes at most two creates and no updates or deletes. Before persistence, the entire batch must pass exact trusted-source quotation checks. Quotes preserve original whitespace, sentence boundaries and leading negation. They are bounded to 80 words and 2,400 normalized characters. Missing model citations bind only to a unique matching trusted input. Deduplication is disabled in this mode so it cannot rewrite existing observations.

Bank, source document and memory identifiers are inserted from trusted inputs, with an explicit unverified-currentness label. Synthetic/test bank names receive a synthetic label. Known ingestion framing is removed from model input only; stored originals remain intact. An invalid batch is rejected before any action is transformed or persisted.

This creates source evidence, not semantic truth validation. Secret screening is partial; private source content and runtime outputs must remain private. Unit tests use newly authored fictional sentences. Real-model acceptance and blackbox API consolidation stories remain follow-up validation before a release.
