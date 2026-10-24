# Phase 20 — Knowledge-Based AI Reply System

## Overview

This phase introduces a new AI reply mode for the YouTube Auto Reply extension.

The current system is primarily trigger-based:

```text
Comment
  ↓
Trigger
  ↓
Match?
  ↓
Generate Reply
```

The new system adds a knowledge-based workflow:

```text
YouTube Comments
        ↓
   Read Comments
        ↓
 Understand Intent
        ↓
 Search Knowledge Base
        ↓
 Find Relevant Information
        ↓
 Is there enough information?
      ↙       ↘
    YES        NO
     ↓          ↓
 Generate     Skip
 grounded     reply
 reply
     ↓
 Validate against Knowledge
     ↓
 Existing Safety / Queue / Dedup
     ↓
 Reply
```

The core principle is:

> **The Knowledge Base is the source of truth. The AI is only allowed to use information supported by the Knowledge Base.**

The goal is to let the model understand what commenters are asking without requiring a predefined trigger phrase, while preventing unsupported claims and hallucinated information.

---

# 1. Goals

The feature should allow the extension to:

- Read YouTube comments.
- Understand the intent of each comment.
- Search user-provided Markdown knowledge files.
- Retrieve only the information relevant to the comment.
- Decide whether the available knowledge is sufficient to answer.
- Generate a natural reply grounded only in the retrieved knowledge.
- Reject unsupported or hallucinated claims.
- Reuse the existing queue, delay, rate-limit, dry-run, deduplication, safety, and YouTube reply automation systems.
- Provide useful processing and debugging information.
- Keep the knowledge base local and controlled by the user.

The feature must not turn the model into an unrestricted factual source.

---

# 2. Non-Negotiable Knowledge Rule

The Knowledge Base is the source of truth.

The AI may:

- Understand the comment.
- Identify intent.
- Identify entities.
- Search/select relevant knowledge.
- Rephrase supported information naturally.

The AI may NOT:

- Invent facts.
- Guess missing information.
- Estimate prices.
- Assume availability.
- Assume shipping times.
- Invent dates.
- Invent policies.
- Fill missing specifications.
- Use general model knowledge as a factual source.
- Treat a likely assumption as confirmed information.

If the available knowledge is insufficient, the preferred behavior is:

```text
NO_SUPPORTED_ANSWER
```

and the comment should be skipped.

The system must prefer skipping a reply over inventing information.

---

# 3. Knowledge Base Structure

The knowledge base should use Markdown files.

Example:

```text
knowledge/
├── books/
│   ├── chemistry.md
│   ├── biology.md
│   └── physics.md
│
├── shipping.md
├── faq.md
├── policies.md
└── general.md
```

The exact storage mechanism can be finalized during implementation, but the conceptual model is a collection of user-controlled `.md` documents.

Example document:

```md
# كتاب التفوق كيمياء 3 ثانوي 2027

## السعر

السعر الحالي: 350 جنيه.

## الشحن

شحن كتاب واحد: 30 جنيه.
الشحن مجاني عند شراء كتابين أو أكثر.

## ملاحظات

هذه الأسعار تخص إصدار 2027.
```

Markdown should remain easy for the user to edit manually.

---

# 4. Knowledge Management UI

Add a Knowledge Base management area to the extension.

Possible UI:

```text
Knowledge Base

[ Add files ]

books/
  chemistry.md
  biology.md
  physics.md

shipping.md
faq.md
```

The UI should eventually support:

- Add files.
- Remove files.
- Replace/update files.
- Enable/disable documents if needed.
- View document information.
- Search knowledge.
- Reload/re-index.
- Display indexing status.
- Display errors for invalid/unreadable files.

Do not make the user manually convert Markdown into a special proprietary format.

---

# 5. Markdown Parser

Markdown documents should not be treated as one giant text block.

The parser should understand the document structure.

Example:

```md
# Chemistry

## Third Secondary

### Price

350 EGP

### Shipping

30 EGP
```

Conceptually, this becomes:

```text
Document: chemistry.md

Section:
Chemistry > Third Secondary > Price

Content:
350 EGP
```

Sections should retain enough hierarchy/context to make retrieval meaningful.

The parser should handle:

- Headings.
- Nested headings.
- Paragraphs.
- Lists.
- Normal Markdown text.
- Empty sections.
- Invalid or unusual Markdown without crashing the extension.

The parser should preserve the original useful text rather than aggressively rewriting it.

---

# 6. Knowledge Index

After Markdown files are loaded, create a searchable knowledge index.

Desired pipeline:

```text
MD files
   ↓
Parser
   ↓
Sections / Chunks
   ↓
Knowledge Index
```

The purpose is to avoid sending every knowledge file to the AI for every comment.

For example, if the user has 50 documents, a question about a chemistry book should not require the model to process all 50 documents.

Each indexed section should have enough metadata to trace it back to its source.

Possible metadata:

```text
documentId
filename
path/category
sectionPath
content
hash
version
updatedAt
enabled
```

---

# 7. Knowledge Chunks / Sections

Knowledge should be stored in logical chunks rather than arbitrary giant blocks.

Example:

```text
chemistry.md
├── Chemistry
│   └── Third Secondary
│       ├── Price
│       ├── Shipping
│       └── Notes
```

Each section/chunk should remain traceable to:

- Source file.
- Section heading path.
- Original content.

This traceability will later support debugging and evidence tracking.

---

# 8. Semantic Understanding

The system should not rely only on exact keyword matching.

Example knowledge:

> كتاب التفوق كيمياء 3 ثانوي سعره 350 جنيه.

Possible comments:

```text
هو كتاب الكيمياء بتاع تالتة ثانوي عندكو بكام؟

جبت كتاب الكيمياء من مكتبة الهدى بـ 350ج هو عندكو بكام؟

طب الكيمياء للصف الثالث سعرها إيه؟

ممكن أعرف تمن كتاب الكيمياء؟
```

These should be recognized as related even when they do not share an exact trigger phrase.

The system should understand:

- Intent.
- Relevant subject/product.
- Grade/year where applicable.
- Other relevant entities.
- What information the commenter is requesting.

---

# 9. AI Intent Understanding

The AI may produce structured intent information.

Example:

```json
{
  "intent": "book_price",
  "entities": {
    "subject": "chemistry",
    "grade": "third_secondary"
  }
}
```

This output is for understanding and retrieval.

It is not itself the source of truth.

The actual factual answer must come from the Knowledge Base.

---

# 10. Semantic Retrieval

The retrieval pipeline should be conceptually:

```text
Comment
  ↓
Intent / semantic understanding
  ↓
Knowledge retrieval
  ↓
Relevant sections
```

The system should retrieve the most relevant knowledge rather than sending the entire knowledge base to the model.

Example:

```text
Comment:
"هو تمن كتاب الكيمياء إيه؟"

Retrieved:

chemistry.md
→ Third Secondary
→ Price

"السعر الحالي: 350 جنيه."
```

The model then receives the relevant knowledge rather than unrelated documents.

---

# 11. Multi-Stage Retrieval

Because the project uses a paid model and accuracy is more important than minimizing every AI request, a stronger retrieval pipeline can be used.

Possible flow:

```text
Comment
 ↓
Semantic retrieval
 ↓
Top relevant knowledge sections
 ↓
AI reranking
 ↓
Top 3 relevant sections
 ↓
Answerability
 ↓
Generate
```

The exact number of candidates should be configurable based on testing.

The priority is relevance and correctness rather than artificially minimizing model calls.

---

# 12. Answerability Gate

Before generating a reply, the system should explicitly determine whether the available knowledge is sufficient.

Example:

```json
{
  "canAnswer": true,
  "confidence": 0.96,
  "reason": "The knowledge contains the current price."
}
```

Or:

```json
{
  "canAnswer": false,
  "reason": "Shipping duration is not provided in the knowledge."
}
```

If `canAnswer` is false:

```text
NO_SUPPORTED_ANSWER
```

No factual reply should be generated.

---

# 13. Example: Missing Information

Knowledge:

```text
Shipping:
30 EGP for one book.
Free for two or more books.
```

Comment:

> الشحن بياخد كام يوم؟

The system must NOT answer:

> الشحن بياخد يومين.

It must recognize that the price/free-shipping information does not contain shipping duration.

Result:

```text
SKIPPED_NO_SUPPORTED_ANSWER
```

---

# 14. Grounded Reply Generation

Once answerability is confirmed, generate the reply using:

```text
COMMENT
+
RELEVANT KNOWLEDGE
+
RESPONSE STYLE
+
BANNED PHRASES
+
OTHER EXISTING REPLY RULES
```

The generation prompt should contain strict grounding instructions.

Recommended core instructions:

```text
You are replying to a YouTube comment.

You must follow these rules:

1. Use only information contained in the provided knowledge.
2. Do not use outside knowledge.
3. Do not invent facts.
4. Do not guess missing information.
5. Do not infer prices, dates, availability, shipping times,
   specifications, or policies unless explicitly supported.
6. If the provided knowledge is insufficient, do not answer
   with an unsupported factual claim.
7. Keep the reply natural and concise.
```

The exact production prompt should be finalized during implementation and tested against real examples.

---

# 15. Evidence-Aware Output

Every knowledge chunk should have an internal identifier.

Example:

```text
KNOWLEDGE-BOOKS-CHEMISTRY-PRICE
```

The model may return structured evidence:

```json
{
  "reply": "كتاب التفوق كيمياء تالتة ثانوي سعره 350 جنيه.",
  "evidence": [
    "KNOWLEDGE-BOOKS-CHEMISTRY-PRICE"
  ]
}
```

The evidence IDs do not need to be shown to YouTube commenters.

They exist for:

- Validation.
- Debugging.
- Explainability.
- Future logging.
- Troubleshooting.

---

# 16. Grounding Validation

Generated replies must not automatically be trusted.

Pipeline:

```text
Generated Reply
      ↓
Grounding Validator
      ↓
Valid?
```

The validator should determine whether the factual claims in the generated reply are supported by the retrieved knowledge.

Example:

Knowledge:

```text
Price: 350 EGP
```

Generated reply:

> الكتاب بـ350 جنيه والشحن خلال يومين.

The second claim is unsupported.

Result:

```text
GROUNDING_VALIDATION_FAILED
```

The system must reject the unsupported reply.

---

# 17. Regeneration Strategy

If grounding validation fails:

```text
First generation
      ↓
Validation failed
      ↓
Regenerate with stricter evidence
      ↓
Validate again
      ↓
Still failed?
      ↓
Skip
```

The system should have a bounded retry count.

It must never enter an unlimited regeneration loop.

Safety is more important than forcing a reply.

---

# 18. Knowledge Conflicts

Conflicting documents must be handled explicitly.

Example:

```text
chemistry-old.md
Price = 350 EGP

chemistry-2027.md
Price = 370 EGP
```

The model must not simply choose one based on intuition.

Possible resolution mechanisms:

- Version.
- Active status.
- Priority.
- Updated timestamp.
- Template scope.
- Explicit document metadata.

Example conceptual metadata:

```text
priority
version
active
updatedAt
```

If the system cannot confidently resolve the conflict:

```text
CONFLICTING_KNOWLEDGE
```

and the reply should be skipped rather than guessed.

---

# 19. Knowledge Versioning

Each document can eventually have:

```text
documentId
filename
version
updatedAt
hash
```

This helps detect changes.

Example:

```text
Old:
350 EGP

Updated:
370 EGP
```

The index should recognize the document update and refresh the relevant knowledge.

---

# 20. Knowledge Reload / Re-indexing

When a knowledge file changes:

```text
Detect change
 ↓
Re-index file
 ↓
New knowledge becomes available
```

The user should not need to rebuild the Chrome extension.

The system should support explicit manual reload/re-index as a fallback.

---

# 21. Static Context vs Knowledge

Keep Static Context.

However, clearly separate responsibilities.

## Static Context

Instructions about behavior and communication.

Example:

```text
You are an assistant for an educational YouTube channel.
Keep replies short and friendly.
```

## Knowledge

Factual information.

Example:

```text
كتاب التفوق كيمياء ث 3ث سعره 350 جنيه.
```

The final prompt can conceptually be:

```text
System Rules
      +
Static Context
      +
Active Template
      +
Retrieved Knowledge
      +
Comment
```

---

# 22. Templates Integration

Existing Templates should remain.

They can eventually be associated with a knowledge scope.

Example:

```text
Template:
كتب التفوق 2027

Knowledge scope:
books/
```

Or:

```text
Template:
كيمياء 3 ثانوي

Knowledge scope:
books/chemistry.md
```

This can reduce irrelevant retrieval and improve accuracy.

Templates should not replace the Knowledge Base.

Templates provide context/scope; the Knowledge Base provides factual source material.

---

# 23. Information Priority

The system should have an explicit information hierarchy.

Conceptually:

```text
1. System safety rules
2. Knowledge Base
3. Active Template
4. Static Context
5. Comment
6. Model general knowledge
```

However:

> Model general knowledge must NOT be used as an external factual source for the reply.

The model may possess general knowledge internally, but factual claims in the generated response must be supported by the provided Knowledge Base when Knowledge Mode is active.

---

# 24. No-Knowledge Behavior

Example:

Comment:

> هل فيه توصيل لمحافظة أسوان؟

Knowledge:

```text
Shipping:
30 EGP for one book.
Free for 2+ books.
```

There is no information about Aswan.

The system must not answer:

```text
أيوه بنوصل كل المحافظات.
```

or:

```text
غالبًا أيوه.
```

or:

```text
أعتقد متاح.
```

Instead:

```text
NO_SUPPORTED_ANSWER
```

and skip.

This is an intentional safe outcome, not a failure.

---

# 25. Reply Modes

The existing trigger system should not be removed.

The extension should support:

## Trigger Mode

```text
Comment
 ↓
Trigger
 ↓
Match
 ↓
Reply
```

Useful when the user wants exact/manual control.

## Knowledge Mode

```text
Comment
 ↓
Understand
 ↓
Search Knowledge
 ↓
Answerability
 ↓
Grounded Reply
```

## Hybrid Mode

Recommended long-term mode:

```text
Comment
       ↓
 ┌───────────────┐
 │ Trigger Match │
 └───────┬───────┘
         │
         ├── Match → Existing Trigger Flow
         │
         └── No Match
                  ↓
          Knowledge Search
                  ↓
            Can Answer?
             /       \
           Yes        No
           ↓           ↓
        AI Reply     Skip
```

This preserves the current trigger system while adding intelligent fallback.

---

# 26. Hybrid Mode Priority

Recommended behavior:

1. Process explicit trigger matches first.
2. If no trigger matches, use Knowledge Mode.
3. If Knowledge Mode cannot support an answer, skip.
4. Do not allow Knowledge Mode to override an explicit fixed reply.
5. Existing fixed-reply behavior remains exact.
6. Existing AI-trigger behavior remains subject to current validation rules.

The exact precedence between multiple matching triggers should remain compatible with the existing trigger implementation unless a dedicated future change is approved.

---

# 27. Existing Queue Integration

The new feature must reuse the current reply pipeline.

Conceptually:

```text
Knowledge Reply
      ↓
Existing Reply Validator
      ↓
Existing Dedup
      ↓
Existing Queue
      ↓
Existing Delay
      ↓
Existing Rate Limiter
      ↓
Existing Dry Run
      ↓
Existing YouTube Reply UI
```

Do not create a second independent posting system.

This protects existing safety and reliability work.

---

# 28. Deduplication Integration

Knowledge-generated replies must use the existing deduplication and handled-comment mechanisms.

The system must preserve:

- Page-session generation deduplication.
- Cross-session handled-comment protection.
- Replay protection.
- Existing fixed-reply repeat behavior.
- Existing AI repeat-response rules where applicable.

Knowledge Mode must not bypass these protections.

---

# 29. Dry Run Integration

Knowledge Mode must respect the existing `dryRun` setting.

When:

```text
dryRun = true
```

the system may:

- Read comments.
- Search knowledge.
- Generate replies.
- Validate replies.
- Display replies.

But it must NOT submit them.

The existing live-post safety gate remains authoritative.

---

# 30. Processing UI

The existing popup counters should be extended to make the Knowledge pipeline understandable.

Current concepts:

```text
Detected
Matched
Generated
Submitted
Failed / Skipped
Current Stage
Total Time
```

Possible new counters:

```text
Detected
Trigger Matches
Knowledge Hits
Answerable
Generated
Submitted
Skipped
Failed
```

Possible stages:

```text
Reading comments
        ↓
Understanding comments
        ↓
Searching knowledge
        ↓
Checking answerability
        ↓
Preparing replies
        ↓
Posting replies
```

The UI should make it obvious why comments were skipped.

---

# 31. Explainability / Debug Logging

Debug logs should explain the pipeline without dumping sensitive or unnecessary content by default.

Example:

```text
Comment:
"الشحن بياخد كام يوم؟"

Knowledge Search:
shipping.md

Relevant:
Shipping price
Free shipping policy

Answerability:
FALSE

Reason:
Shipping duration is not provided.

Action:
SKIPPED_NO_SUPPORTED_ANSWER
```

Other useful statuses:

```text
KNOWLEDGE_RETRIEVED
NO_RELEVANT_KNOWLEDGE
ANSWERABILITY_CONFIRMED
NO_SUPPORTED_ANSWER
GROUNDING_VALIDATION_FAILED
CONFLICTING_KNOWLEDGE
KNOWLEDGE_REPLY_GENERATED
```

Use the project's existing diagnostics/logging mechanism rather than introducing a parallel logging system.

---

# 32. Error Categories

The feature should distinguish between:

### Expected skip

```text
NO_SUPPORTED_ANSWER
```

### Retrieval issue

```text
NO_RELEVANT_KNOWLEDGE
```

### Knowledge problem

```text
CONFLICTING_KNOWLEDGE
INVALID_KNOWLEDGE_DOCUMENT
```

### AI issue

```text
INTENT_PARSE_FAILED
ANSWERABILITY_PARSE_FAILED
GENERATION_FAILED
```

### Safety issue

```text
GROUNDING_VALIDATION_FAILED
REPLY_VALIDATION_FAILED
```

### System issue

```text
KNOWLEDGE_INDEX_FAILED
```

The user should not see all internal details in normal UI, but diagnostics should preserve useful information.

---

# 33. Performance Strategy

Because the project uses a paid model, optimization should focus on useful performance rather than artificially minimizing every request.

The system can use AI for:

- Intent understanding.
- Semantic retrieval/reranking.
- Answerability.
- Grounded generation.
- Grounding validation.

However, deterministic/local processing should still handle:

- File loading.
- Markdown parsing.
- Indexing.
- Hashing.
- Caching.
- Existing trigger matching.
- Existing queue management.
- Deduplication.
- Rate limiting.
- Safety checks that do not require AI.

The architecture should avoid unnecessary repeated work.

---

# 34. Caching

Potential future caching layers:

```text
Comment
 ↓
Intent cache
 ↓
Retrieval cache
 ↓
Knowledge result
```

Cache keys must account for:

- Comment content.
- Knowledge version/hash.
- Active template.
- Relevant configuration.

A knowledge update must invalidate stale factual retrieval results.

Do not allow old knowledge to override newer knowledge because of stale cache data.

---

# 35. Batch Processing

The system may eventually process comments in batches where supported.

Example:

```text
47 comments
 ↓
Batch semantic understanding
 ↓
Knowledge retrieval
 ↓
Answerability
 ↓
Generation only for supported comments
```

Batching must not break:

- Per-comment deduplication.
- Queue ordering.
- Rate limiting.
- Reply timing.
- Error isolation.

---

# 36. Security / Privacy

The knowledge system should remain local where possible.

Conceptual architecture:

```text
Your PC
│
├── Chrome Extension
│
├── Local Knowledge Files
│
└── LM Studio / configured AI endpoint
```

No cloud knowledge database should be required by the feature.

The system should only send the necessary:

- Comment text.
- Relevant knowledge.
- Required prompt/configuration.

It should not blindly send the entire knowledge repository to every model request.

---

# 37. Testing Strategy

The feature requires deterministic unit tests, integration tests, and real Chrome testing.

## Knowledge parsing tests

Test:

- Valid Markdown.
- Nested headings.
- Empty sections.
- Multiple files.
- Invalid documents.
- Duplicate files.
- File replacement.
- Hash changes.

## Retrieval tests

Test:

- Exact relevance.
- Different wording.
- Synonyms.
- Arabic wording variations.
- Irrelevant comments.
- Multiple relevant sections.
- No relevant knowledge.

## Answerability tests

Test:

- Fully supported answer.
- Partially supported question.
- Missing information.
- Ambiguous information.
- Conflicting information.

## Grounding tests

Test:

```text
Knowledge:
Price = 350

Reply:
Price = 350
→ PASS
```

and:

```text
Knowledge:
Price = 350

Reply:
Price = 350 + shipping in 2 days
→ FAIL
```

## Safety tests

Test:

- Dry run.
- Live mode.
- Existing reply validator.
- Existing deduplication.
- Queue.
- Rate limiter.
- Page session behavior.
- Fixed replies.
- Existing trigger replies.

---

# 38. Critical Acceptance Tests

### Test 1 — Different wording

Knowledge:

```text
كتاب الكيمياء 3 ثانوي = 350 جنيه
```

Comment:

```text
هو تمن كتاب الكيمياء إيه؟
```

Expected:

```text
Supported answer
```

---

### Test 2 — Exact current example

Comment:

```text
تم
جبت كتاب الكيمياء من مكتبة الهدى بـ ٣٥٠ج هو عندكو بكام
```

Knowledge:

```text
كتاب التفوق كيمياء 3 ثانوي = 350 جنيه
```

Expected:

```text
Knowledge match
Answerable
Grounded reply
```

The presence of the word `تم` must not be required when Knowledge Mode is active.

---

### Test 3 — Missing information

Knowledge:

```text
Book price = 350 EGP
```

Comment:

```text
الشحن بياخد كام يوم؟
```

Expected:

```text
NO_SUPPORTED_ANSWER
Skip
```

---

### Test 4 — Hallucinated shipping duration

Knowledge:

```text
Book price = 350 EGP
```

Model attempts:

```text
الكتاب بـ350 جنيه والشحن خلال يومين.
```

Expected:

```text
GROUNDING_VALIDATION_FAILED
```

---

### Test 5 — Conflicting documents

Knowledge:

```text
chemistry-old.md = 350
chemistry-2027.md = 370
```

If conflict cannot be resolved using metadata:

```text
CONFLICTING_KNOWLEDGE
Skip
```

---

### Test 6 — Existing Trigger still works

A comment matches an existing trigger.

Expected:

```text
Existing Trigger Flow
```

Knowledge Mode must not break it.

---

### Test 7 — Hybrid fallback

Comment does not match any trigger but is answerable from Knowledge.

Expected:

```text
Trigger → No match
Knowledge → Answerable
Reply
```

---

### Test 8 — Hybrid no-answer

Comment does not match any trigger and knowledge does not support an answer.

Expected:

```text
Trigger → No match
Knowledge → No supported answer
Skip
```

---

### Test 9 — Dry run

Knowledge answer is generated.

Expected:

```text
Generated
Submitted = 0
Click count = 0
```

---

### Test 10 — Knowledge update

Old:

```text
350 EGP
```

Update document:

```text
370 EGP
```

Expected:

```text
Index refreshed
New retrieval uses 370 EGP
Old cached knowledge is not used
```

---

# 39. Full Architecture

Target architecture:

```text
                         YouTube
                            │
                            ↓
                     Content Script
                            │
                            ↓
                    Comment Detection
                            │
                            ↓
                  Background / Core Layer
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ↓                             ↓
       Trigger System               Knowledge System
             │                             │
       Trigger Match                 Intent Analysis
             │                             │
       ┌─────┴─────┐                 Retrieval
       │           │                     │
      YES          NO                 Reranking
       │           │                     │
       ↓           └──────────────→ Answerability
  Trigger Reply                         │
                                        ↓
                                Grounded Generation
                                        │
                                        ↓
                                Grounding Validation
                                        │
                         ┌──────────────┴──────────────┐
                         │                             │
                         ↓                             ↓
                      Valid                         Invalid
                         │                             │
                         ↓                             ↓
                  Existing Queue                  Retry / Skip
                         │
                         ↓
                  Existing Safety
                         │
                         ↓
                  Existing Dedup
                         │
                         ↓
                  Existing Dry Run
                         │
                         ↓
                  YouTube Reply UI
```

---

# 40. Phase 20 Implementation Plan

The complete phase is divided into the following implementation milestones.

## 20.1 — Knowledge Base Architecture

Define:

- Data model.
- Document model.
- Section/chunk model.
- Metadata.
- Storage strategy.
- Index lifecycle.
- Error model.

No unrelated refactor.

---

## 20.2 — Markdown Document Management

Implement:

- Add.
- Remove.
- Replace/update.
- Load.
- Basic metadata.
- Validation.

---

## 20.3 — Markdown Parser & Sections

Implement:

- Heading hierarchy.
- Sections.
- Content extraction.
- Source mapping.

---

## 20.4 — Knowledge Index

Implement:

- Index creation.
- Index refresh.
- Hash/version tracking.
- Document updates.
- Searchable section records.

---

## 20.5 — Semantic Retrieval

Implement retrieval from the indexed knowledge.

Support:

- Semantic relevance.
- Multiple candidate sections.
- No-result state.
- Relevance metadata.

---

## 20.6 — AI Intent Understanding

Implement structured comment understanding:

```json
{
  "intent": "...",
  "entities": {}
}
```

Validate the structured output before using it.

---

## 20.7 — Answerability Gate

Implement:

```text
CAN_ANSWER
NO_SUPPORTED_ANSWER
CONFLICTING_KNOWLEDGE
```

with structured reasons.

---

## 20.8 — Grounded Prompt Generation

Build the Knowledge Mode generation prompt.

Include:

- Comment.
- Retrieved knowledge.
- Static Context.
- Active Template.
- Response style.
- Banned phrases.
- Grounding rules.

---

## 20.9 — Evidence-Aware Output

Add:

- Evidence IDs.
- Structured output.
- Evidence mapping.
- Output validation.

---

## 20.10 — Grounding Validation

Verify that generated factual claims are supported by the retrieved knowledge.

Reject unsupported claims.

---

## 20.11 — Hallucination Rejection

Implement bounded regeneration and final skip behavior.

Never allow an endless retry loop.

---

## 20.12 — Knowledge Conflict Handling

Implement:

- Priority.
- Version.
- Active status.
- Updated timestamp.
- Conflict detection.

---

## 20.13 — Templates ↔ Knowledge Integration

Allow active templates to define or narrow knowledge scope where useful.

Keep Template context and factual Knowledge separate.

---

## 20.14 — Knowledge Mode

Add a dedicated mode:

```text
Reply Mode:
- Trigger
- Knowledge
- Hybrid
```

Knowledge Mode should use the full knowledge pipeline.

---

## 20.15 — Hybrid Mode

Implement:

```text
Trigger first
 ↓
If no match
 ↓
Knowledge fallback
```

Preserve existing Trigger and Fixed Reply behavior.

---

## 20.16 — Queue Integration

Connect Knowledge replies to the existing queue.

No second posting queue.

---

## 20.17 — Dedup / Handled Integration

Connect Knowledge replies to existing:

- Generation dedup.
- Page-session dedup.
- Handled fingerprints.
- Repeat protection.

---

## 20.18 — Processing UI

Add:

- Knowledge hits.
- Answerable count.
- Skip reasons.
- Current Knowledge stage.
- Existing total time.

---

## 20.19 — Debug / Explainability

Add structured diagnostic events for:

- Retrieval.
- Answerability.
- Evidence.
- Grounding validation.
- Skips.
- Conflicts.

Use the existing project diagnostic system.

---

## 20.20 — Knowledge Reload / Update

Implement:

- Change detection.
- Re-index.
- Cache invalidation.
- Manual reload.

---

## 20.21 — Performance Optimization

Optimize:

- Parsing.
- Indexing.
- Retrieval.
- Caching.
- Batch operations.

Do not sacrifice correctness for small performance gains.

---

## 20.22 — Full Test Suite

Run:

- Unit tests.
- Integration tests.
- Regression tests.
- Safety tests.
- Queue tests.
- Dedup tests.
- Knowledge tests.
- Grounding tests.

Target:

```text
0 failed
```

and no regressions in existing features.

---

## 20.23 — Real YouTube Runtime Testing

Test in real Chrome with:

- Real YouTube comments.
- Real Knowledge files.
- Real configured model.
- Dry Run first.
- Live mode only after safety verification.

Verify:

- Detection.
- Retrieval.
- Answerability.
- Generation.
- Grounding.
- Queue.
- Reply box.
- Dry run.
- Live submit.
- Dedup.
- Page reload behavior.

---

## 20.24 — Documentation & Packaging

Update:

- README.
- User documentation.
- Knowledge Base instructions.
- Mode documentation.
- Safety documentation.
- Packaging checks.
- Version notes.

Do not leave stale documentation describing Trigger-only behavior.

---

# 41. Final User Experience

The final experience should look approximately like:

```text
User adds:

knowledge/
├── books.md
├── shipping.md
├── faq.md
└── policies.md
```

Then selects:

```text
Reply Mode:
● Knowledge
```

The extension reads comments:

```text
47 comments detected
```

For each comment:

```text
Comment
 ↓
Understand
 ↓
Search user's knowledge
 ↓
Can answer?
```

Example:

```text
"هو كتاب الكيمياء بكام؟"

Knowledge:
chemistry.md
→ Price
→ 350 EGP

Answerable:
YES

Reply:
"كتاب التفوق كيمياء تالتة ثانوي سعره 350 جنيه."
```

Another:

```text
"الشحن بياخد كام يوم؟"

Knowledge:
shipping.md
→ No shipping duration

Answerable:
NO

Action:
Skip
```

No invented answer.

---

# 42. Final Design Principle

The most important design rule for Phase 20 is:

> **The model is responsible for understanding and wording. The Knowledge Base is responsible for facts.**

The system should never reverse these responsibilities.

The AI can be intelligent about:

- What the commenter means.
- Which information is relevant.
- How to phrase the response.

But it cannot decide factual information that is not supported by the user's Knowledge Base.

This is what makes the feature a **grounded AI reply system** rather than simply a more complicated trigger system.

---

# Phase 20 Completion Criteria

Phase 20 is complete only when all of the following are true:

- [ ] Markdown knowledge files can be loaded.
- [ ] Documents are parsed into searchable sections.
- [ ] Knowledge is indexed.
- [ ] Comments can be semantically understood without relying on exact triggers.
- [ ] Relevant knowledge can be retrieved.
- [ ] The system can determine whether an answer is supported.
- [ ] Unsupported questions are skipped.
- [ ] Generated replies are grounded in retrieved knowledge.
- [ ] Unsupported claims are rejected.
- [ ] Knowledge conflicts are handled safely.
- [ ] Templates integrate correctly.
- [ ] Trigger Mode still works.
- [ ] Knowledge Mode works.
- [ ] Hybrid Mode works.
- [ ] Existing queue is reused.
- [ ] Existing deduplication is reused.
- [ ] Existing dry-run safety is preserved.
- [ ] Processing UI exposes useful Knowledge pipeline status.
- [ ] Diagnostics explain important skip/failure reasons.
- [ ] Knowledge updates refresh the index.
- [ ] Full automated tests pass.
- [ ] Real Chrome runtime testing passes.
- [ ] Packaging/documentation are updated.
