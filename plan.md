# Chrome Extension — LM Studio Auto Comment Replier

## Project Goal

بناء Chrome Extension تربط المتصفح بـ **LM Studio API** المحلي، وتراقب تعليقات منصة محددة، وعندما يحتوي التعليق على كلمة أو عبارة يحددها المستخدم، يتم:

1. اكتشاف التعليق.
2. التأكد أنه يطابق Trigger Rule.
3. إرسال التعليق إلى LM Studio.
4. توليد رد قصير وطبيعي.
5. إدخال الرد في واجهة الموقع.
6. نشر الرد.
7. تسجيل العملية ومنع تكرار الرد على نفس التعليق.

> **MVP Rule:** نبدأ بمنصة واحدة فقط في أول Adapter. الـ Core يكون منفصلًا عن كود المنصة.
>
> **Safety/Platform Rule:** لا يتم تصميم الإضافة لتجاوز CAPTCHA أو أنظمة مكافحة البوت أو تنفيذ spam واسع النطاق. يجب الالتزام بشروط استخدام المنصة المستهدفة.

---

# How to Use This Plan With a Small Coding Model

الخطة مقسمة إلى Phases، وكل Phase إلى Tasks صغيرة.

**قاعدة مهمة للموديل:**

- نفذ Task واحدة فقط في كل مرة.
- لا تبدأ Task التالية قبل التأكد أن الحالية تعمل.
- لا تعيد كتابة ملفات لم تتغير الحاجة إليها.
- لا تعمل Refactor كبير أثناء تنفيذ Task صغيرة.
- بعد كل Task شغّل الاختبار المناسب.
- عند الخطأ: أصلح الخطأ الحالي فقط قبل إضافة Feature جديدة.

صيغة العمل المقترحة:

```text
Read Phase N
→ Execute Task N.1
→ Test
→ Execute Task N.2
→ Test
→ ...
```

---

# Architecture

```text
┌──────────────────────────────┐
│         Chrome Popup         │
│ ON/OFF / Status / Quick UX   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│     Background Service       │
│ State / Queue / API / Logs   │
└──────────────┬───────────────┘
               │
        messages / HTTP
               │
      ┌────────┴─────────┐
      ▼                  ▼
┌───────────────┐  ┌──────────────────┐
│ Content Script│  │    LM Studio     │
│ DOM / Comments│  │ OpenAI API       │
│ Reply Actions │  │ localhost        │
└───────┬───────┘  └──────────────────┘
        │
        ▼
┌──────────────────────────────┐
│       Target Website         │
└──────────────────────────────┘
```

---

# Proposed Project Structure

```text
lmstudio-comment-replier/
│
├─ manifest.json
├─ README.md
│
├─ src/
│  ├─ background/
│  │  ├─ service-worker.js
│  │  ├─ api-client.js
│  │  ├─ queue.js
│  │  ├─ matcher.js
│  │  └─ storage.js
│  │
│  ├─ content/
│  │  ├─ content.js
│  │  ├─ observer.js
│  │  ├─ comment-parser.js
│  │  ├─ reply-handler.js
│  │  └─ site-adapter.js
│  │
│  ├─ popup/
│  │  ├─ popup.html
│  │  ├─ popup.css
│  │  └─ popup.js
│  │
│  ├─ options/
│  │  ├─ options.html
│  │  ├─ options.css
│  │  └─ options.js
│  │
│  └─ shared/
│     ├─ constants.js
│     ├─ schemas.js
│     └─ utils.js
│
├─ adapters/
│  └─ example-site.js
│
└─ assets/
   ├─ icon16.png
   ├─ icon48.png
   └─ icon128.png
```

---

# PHASE 0 — Project Decisions

## Task 0.1 — Choose Target Platform

### Goal
تحديد أول منصة سيتم دعمها في الـ MVP.

### Output
قيمة واحدة مثل:

```text
facebook
```

أو:

```text
youtube
```

### Done When
المنصة الأولى محددة بوضوح.

---

## Task 0.2 — Define MVP Scope

### Include

- Chrome MV3
- LM Studio
- Trigger matching
- Comment detection
- Reply generation
- Reply publishing
- Deduplication
- Basic logs
- Basic rate limit

### Exclude

- Multi-platform support
- Cloud backend
- RAG
- Image understanding
- Multi-account management
- CAPTCHA bypass

### Done When
يوجد Scope مكتوب ولا توجد Features إضافية غير ضرورية للـ MVP.

---

# PHASE 1 — Chrome Extension Skeleton

## Task 1.1 — Create Folder Structure

### Goal
إنشاء مجلدات المشروع والملفات الفارغة الأساسية.

### Files

```text
manifest.json
src/background/service-worker.js
src/popup/popup.html
src/popup/popup.css
src/popup/popup.js
src/options/options.html
src/options/options.css
src/options/options.js
```

### Test
تأكد أن كل الملفات موجودة.

---

## Task 1.2 — Create Minimal Manifest

### Goal
إنشاء `manifest.json` بصيغة Manifest V3.

### Initial Permissions

```text
storage
activeTab
scripting
```

وأي `host_permissions` لازمة فقط.

### Test
حمّل Extension من:

```text
chrome://extensions
```

مع Developer Mode.

### Done When
الإضافة تظهر بدون Manifest errors.

---

## Task 1.3 — Create Basic Popup

### Goal
عرض Popup بسيط.

### UI

```text
LM Studio Comment Replier

Status: OFF

[ ON / OFF ]

[ Settings ]
```

### Done When
Popup يفتح ويعرض الواجهة.

---

## Task 1.4 — Create Basic Options Page

### Goal
صفحة Settings تعمل وتفتح من Popup.

### Sections

```text
LM Studio
Triggers
Reply Behavior
Logs
```

في البداية بدون Logic معقد.

---

## Task 1.5 — Create Service Worker

### Goal
تشغيل `service-worker.js` واستقبال رسائل بسيطة.

### Test
Popup يرسل message إلى Service Worker، والـ worker يرد بـ `pong`.

---

# PHASE 2 — Storage Layer

## Task 2.1 — Define Default Settings

### Goal
تعريف Default Config واحد.

### Example

```js
{
  enabled: false,
  lmStudio: {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    model: "",
    temperature: 0.7,
    maxTokens: 150,
    systemPrompt: ""
  },
  triggers: [],
  replyBehavior: {
    minDelayMs: 8000,
    maxDelayMs: 20000,
    maxRepliesPerHour: 30,
    ignoreOwnComments: true,
    ignoreHandledComments: true
  }
}
```

---

## Task 2.2 — Implement `getSettings()`

### Goal
قراءة الإعدادات من `chrome.storage.local`.

### Done When
الدالة ترجع Default Settings حتى لو Storage فاضي.

---

## Task 2.3 — Implement `saveSettings()`

### Goal
حفظ الإعدادات.

### Test
غيّر قيمة → Reload Extension → تأكد أنها ما زالت موجودة.

---

## Task 2.4 — Connect Settings UI to Storage

### Goal
ربط حقل أو حقلين أولًا بالـ Storage.

ابدأ مثلًا بـ:

```text
Base URL
Model
```

ثم أكمل باقي الحقول في Task مستقلة.

---

# PHASE 3 — LM Studio Connection

## Task 3.1 — Create LM Studio API Client

### Goal
إنشاء:

```text
src/background/api-client.js
```

وفيه دالة:

```js
chatCompletion(messages, options)
```

### Target Endpoint

```text
POST {baseUrl}/chat/completions
```

---

## Task 3.2 — Add Basic Timeout

### Goal
منع الطلب من البقاء مفتوحًا للأبد.

### Suggested Default

```text
30 seconds
```

---

## Task 3.3 — Add `/v1/models`

### Goal
جلب الـ Models من LM Studio.

### Endpoint

```text
GET {baseUrl}/models
```

### Output
Array بأسماء الموديلات.

---

## Task 3.4 — Show Models in Settings

### Goal
Dropdown للموديل بدل الكتابة اليدوية.

### UI

```text
Model
[ qwen/... ▼ ]

[ Refresh Models ]
```

---

## Task 3.5 — Add Connection Test

### Goal
زر:

```text
[Test Connection]
```

### Success

```text
Connected
Model available
```

### Failure
رسالة واضحة.

---

## Task 3.6 — Add Chat Test Button

### Goal
إرسال Prompt تجريبي من Settings إلى LM Studio.

### Test Input

```text
اكتب رد قصير على: بكام الكتاب؟
```

### Done When
يظهر رد الموديل في Settings.

---

# PHASE 4 — Trigger Engine

## Task 4.1 — Define Trigger Rule Schema

### Rule

```js
{
  id: "rule-001",
  enabled: true,
  phrases: ["السعر", "بكام"],
  matchMode: "contains",
  caseSensitive: false
}
```

---

## Task 4.2 — Implement `contains`

### Goal
Matcher بسيط.

### Test

```text
Comment: بكام الكتاب؟
Trigger: بكام
=> MATCH
```

---

## Task 4.3 — Implement `exact`

### Test

```text
Comment: بكام
Trigger: بكام
=> MATCH

Comment: بكام الكتاب
Trigger: بكام
=> NO MATCH
```

---

## Task 4.4 — Add Arabic Normalization

### Goal
عمل function منفصلة مثل:

```js
normalizeArabic(text)
```

### Initial Rules

- إزالة التشكيل.
- توحيد أ / إ / آ إلى ا.
- إزالة المسافات الزائدة.
- تنظيف علامات ترقيم بسيطة.

### Done When

```text
بِكام الكتاب؟
بكام الكتاب
بكام   الكتاب
```
تتقارب في المقارنة.

---

## Task 4.5 — Add Trigger CRUD

### Goal
إضافة وحذف وتعديل Trigger Rule.

### UI

```text
Phrase
[ بكام ]

[ Add Trigger ]
```

---

## Task 4.6 — Add Trigger List UI

### Goal
عرض Rules المحفوظة.

مثال:

```text
✓ بكام
✓ السعر
✓ منين أجيب
```

---

## Task 4.7 — Add Matcher Unit Tests

### Goal
إنشاء مجموعة Tests للمطابقة.

### Minimum Cases

- contains match
- contains no match
- exact match
- exact no match
- Arabic normalization
- disabled rule

---

# PHASE 5 — Content Script + Comment Detection

## Task 5.1 — Inject Content Script

### Goal
تشغيل `content.js` على المنصة المستهدفة فقط.

### Test
يظهر log داخل الصفحة عند التحميل.

---

## Task 5.2 — Create `SiteAdapter` Interface

### Goal
تعريف API موحد للمنصة.

```js
class SiteAdapter {
  isSupportedPage() {}
  findCommentNodes() {}
  parseComment(node) {}
  findReplyButton(comment) {}
  openReplyBox(comment) {}
  setReplyText(replyBox, text) {}
  submitReply(replyBox) {}
}
```

لا تنفذ كل methods في نفس Task إذا كان الموديل صغيرًا.

---

## Task 5.3 — Detect Existing Comments

### Goal
العثور على comment elements الموجودة عند فتح الصفحة.

### Done When
Console يعرض عدد التعليقات المكتشفة.

---

## Task 5.4 — Parse One Comment

### Goal
استخراج النص من Comment واحد.

### Output

```js
{
  id,
  author,
  text,
  element
}
```

---

## Task 5.5 — Detect New Comments With MutationObserver

### Goal
اكتشاف comments التي تظهر بعد تحميل الصفحة.

### Test
انزل الصفحة / حمّل المزيد من التعليقات → يجب اكتشاف العناصر الجديدة.

---

## Task 5.6 — Normalize Parsed Comment Object

### Goal
كل التعليقات تستخدم نفس الشكل الداخلي مهما اختلف DOM.

---

# PHASE 6 — Message Bridge

## Task 6.1 — Content → Background Message

### Goal
إرسال Comment object من Content Script إلى Service Worker.

### Message Type

```text
COMMENT_DETECTED
```

---

## Task 6.2 — Background → Content Response

### Goal
إضافة Message بسيطة لاختبار الـ bridge.

### Test

```text
content → background → content
```

---

## Task 6.3 — Send Match Result

### Goal
Background يقرر:

```text
MATCH
NO_MATCH
```

ويرسل النتيجة للـ Content Script.

---

# PHASE 7 — Reply Generation

## Task 7.1 — Create Prompt Builder

### Goal
Function منفصلة:

```js
buildReplyPrompt(comment, settings)
```

### Input

```text
comment.text
systemPrompt
optional context
```

---

## Task 7.2 — Call LM Studio For One Comment

### Goal
عندما يكون Comment Match، يتم استدعاء LM Studio.

لا تضف Queue في هذه Task.

---

## Task 7.3 — Extract Assistant Text

### Goal
تحويل API response إلى String فقط.

---

## Task 7.4 — Validate Reply

### Rules

- ليس فارغًا.
- تحت حد طول معين.
- لا يحتوي `{{...}}`.
- لا يحتوي Markdown code fence غير مطلوب.

### Function

```js
validateReply(reply)
```

---

## Task 7.5 — Prevent Duplicate Generated Replies

### Goal
منع إعادة نفس الرد حرفيًا لنفس Comment أو تعليق مشابه في نفس الدورة.

---

# PHASE 8 — Reply UI Automation

## Task 8.1 — Find Reply Button

### Goal
تحديد زر Reply الخاص بالتعليق.

### Done When
يمكن الحصول على العنصر الصحيح في Console.

---

## Task 8.2 — Open Reply Box

### Goal
فتح خانة كتابة الرد.

### Test
زر Reply → Reply Box يظهر.

---

## Task 8.3 — Insert Text

### Goal
إدخال نص الرد في خانة reply.

### Important
التأكد من Trigger للـ input/change events إذا احتاجت المنصة ذلك.

---

## Task 8.4 — Submit Reply

### Goal
تنفيذ الضغط على Submit.

### Test
انشر Reply تجريبي واحد فقط.

---

## Task 8.5 — Detect Publish Success

### Goal
تمييز:

```text
SUCCESS
FAILED
UNKNOWN
```

---

# PHASE 9 — Deduplication

## Task 9.1 — Create Comment Fingerprint

### Preferred

```text
site + page + commentId
```

### Fallback

```text
author + normalizedText + approximateTimestamp
```

---

## Task 9.2 — Save Handled Comment

### Goal
تخزين comment بعد نجاح النشر.

---

## Task 9.3 — Check Handled Comment

### Goal
قبل أي Reply:

```text
handled?
YES → skip
NO  → continue
```

---

## Task 9.4 — Cleanup Old Records

### Goal
عدم ترك Storage يكبر بلا حدود.

### Simple Rule
احذف السجلات الأقدم من فترة محددة.

---

# PHASE 10 — Queue System

## Task 10.1 — Create Queue Data Structure

### Goal
Queue بسيطة FIFO.

```text
A
B
C
```

---

## Task 10.2 — Add One-At-a-Time Processing

### Goal
لا تتم معالجة أكثر من Comment في نفس الوقت.

```text
A → finish → B → finish → C
```

---

## Task 10.3 — Add Minimum Delay

### Goal
إضافة delay بين العمليات.

---

## Task 10.4 — Add Random Delay

### Goal
اختيار delay عشوائي داخل نطاق:

```text
minDelayMs → maxDelayMs
```

---

## Task 10.5 — Add Max Replies Per Hour

### Goal
Counter بسيط لعدد الردود خلال الساعة.

إذا وصل الحد:

```text
Queue pauses
```

---

## Task 10.6 — Add Pause / Resume

### Goal
زر Pause يوقف الـ queue بدون فقد البيانات الموجودة فيها.

---

# PHASE 11 — Logs

## Task 11.1 — Define Log Schema

```js
{
  timestamp,
  site,
  commentId,
  commentText,
  matchedRule,
  generatedReply,
  status,
  error
}
```

### Status Values

```text
matched
queued
generated
published
skipped
failed
```

---

## Task 11.2 — Save Logs

### Goal
حفظ آخر عدد محدود من Logs في `chrome.storage.local`.

---

## Task 11.3 — Show Logs Page

### Goal
عرض آخر العمليات فقط.

---

## Task 11.4 — Add Clear Logs

### Goal
زر لحذف Logs.

---

# PHASE 12 — Popup Control

## Task 12.1 — Add Real ON/OFF State

### Goal
ربط Popup بالـ `enabled` setting.

---

## Task 12.2 — Show Connection Status

### Possible States

```text
Connected
Disconnected
Unknown
```

---

## Task 12.3 — Show Current Model

### Goal
عرض اسم الـ model الحالي.

---

## Task 12.4 — Show Queue Count

### Example

```text
Queue: 3
```

---

## Task 12.5 — Show Replies Today

### Example

```text
Replies today: 12 / 30
```

---

# PHASE 13 — Error Handling

## Task 13.1 — Handle LM Studio Offline

### Expected

```text
Cannot connect to LM Studio.
```

---

## Task 13.2 — Handle Invalid Model

### Expected
رسالة واضحة بدون crash.

---

## Task 13.3 — Handle API Timeout

### Goal
تسجيل timeout وعدم نشر أي رد غير مكتمل.

---

## Task 13.4 — Handle Empty AI Response

### Goal
`failed` بدل محاولة النشر.

---

## Task 13.5 — Handle DOM Changes

### Goal
لو تغير DOM أثناء العملية:

- أعد البحث عن العناصر.
- لا تعمل Crash.
- لا تعيد Publish تلقائيًا بدون تحقق.

---

# PHASE 14 — Arabic Reply Quality

## Task 14.1 — Create Default Arabic System Prompt

### Goal
Prompt مناسب لتعليقات عربية قصيرة.

### Example

```text
أنت مسؤول عن الرد على تعليقات العملاء.
اكتب ردًا طبيعيًا وقصيرًا ومحترمًا.
استخدم نفس لغة تعليق المستخدم.
لا تخترع أسعارًا أو روابط أو معلومات غير موجودة.
لا تذكر أنك نموذج ذكاء اصطناعي.
```

---

## Task 14.2 — Add Response Style

### Options

```text
friendly
professional
short
```

لا تضف Styles أكثر في الـ MVP إلا إذا لزم الأمر.

---

## Task 14.3 — Add Optional Static Context

### Goal
السماح للمستخدم بإضافة معلومات ثابتة مثل:

```text
اسم المنتج
السعر
الرابط
معلومات مختصرة
```

هذه البيانات تذهب إلى Prompt فقط عند الحاجة.

---

# PHASE 15 — Testing

## Task 15.1 — Extension Load Test

اختبار تثبيت Extension من `chrome://extensions`.

---

## Task 15.2 — Storage Test

اختبار:

```text
save → reload → read
```

---

## Task 15.3 — LM Studio Test

اختبار الحالات:

- LM Studio OFF
- LM Studio ON
- Model صحيح
- Model خاطئ
- Response فارغ
- Timeout

---

## Task 15.4 — Matcher Test

اختبار:

```text
بكام الكتاب؟      → MATCH
السعر كام؟        → MATCH
السلام عليكم      → NO MATCH
```

---

## Task 15.5 — Detection Test

فتح الصفحة ثم إضافة/تحميل Comments جديدة.

---

## Task 15.6 — Dedup Test

نفس Comment لا يتم الرد عليه مرتين.

---

## Task 15.7 — Queue Test

3 Comments:

```text
A → B → C
```

يجب أن تتم معالجتها بالتتابع.

---

## Task 15.8 — Reply Test

اختبار Comment حقيقي واحد فقط:

```text
Detect
→ Match
→ Generate
→ Open Reply
→ Insert
→ Submit
→ Verify
```

---

## Task 15.9 — Browser Restart Test

أغلق Chrome وافتحه مرة أخرى.

### Verify

- Settings محفوظة.
- Extension تعمل.
- Queue لا تسبب duplicate replies.

---

# PHASE 16 — UX Cleanup

## Task 16.1 — Improve Popup Layout

جعل أهم المعلومات ظاهرة بدون ازدحام.

---

## Task 16.2 — Improve Settings Form

تقسيم الإعدادات إلى Sections واضحة.

---

## Task 16.3 — Add Confirmation For Risky Settings

مثل:

```text
Max replies/hour
```

---

## Task 16.4 — Add Empty States

مثل:

```text
No triggers yet.
```

---

# PHASE 17 — Security / Privacy Review

## Task 17.1 — Review Permissions

احذف أي Permission غير مستخدمة.

---

## Task 17.2 — Review Stored Data

تأكد من عدم تخزين:

- Cookies
- Session tokens
- Passwords
- أي Credentials غير ضرورية

---

## Task 17.3 — Review API Data Flow

التحقق أن Comment → LM Studio محلي، ولا توجد خدمة Cloud غير مقصودة.

---

## Task 17.4 — Review Host Permissions

استخدم أقل نطاقات ممكنة.

---

# PHASE 18 — Packaging

## Task 18.1 — Final Manifest Check

راجع:

- name
- version
- permissions
- host_permissions
- service worker
- popup
- options

---

## Task 18.2 — Fresh Install Test

اختبر الإضافة على Chrome Profile جديد.

---

## Task 18.3 — Remove Debug Logs

احذف Console Logs غير الضرورية أو حوّلها إلى Debug Mode.

---

## Task 18.4 — Write README

README يجب أن يحتوي على:

1. تثبيت Extension.
2. تشغيل LM Studio Server.
3. إعداد Base URL.
4. اختيار Model.
5. إضافة Trigger.
6. تشغيل Auto Reply.
7. Troubleshooting.

---

## Task 18.5 — Create ZIP

تجهيز نسخة ZIP للـ local installation.

---

# PHASE 19 — Post-MVP Improvements

لا تبدأ هذه المرحلة قبل اكتمال الـ MVP بالكامل.

## Task 19.1 — Add Second Platform

استخدم نفس الـ Core مع Adapter جديد.

---

## Task 19.2 — Improve Arabic Matching

إضافة normalization أوسع عند الحاجة.

---

## Task 19.3 — Better Queue Recovery

استرجاع queue بعد reload عند الحاجة.

---

## Task 19.4 — Better Reply Validation

إضافة blacklist / length / repeated-response checks.

---

## Task 19.5 — Context Templates

السماح للمستخدم بعمل Templates مختلفة للردود.

---

# Core Data Structures

## Settings

```js
{
  enabled: false,
  lmStudio: {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    model: "",
    temperature: 0.7,
    maxTokens: 150,
    systemPrompt: ""
  },
  triggers: [],
  replyBehavior: {
    minDelayMs: 8000,
    maxDelayMs: 20000,
    maxRepliesPerHour: 30,
    ignoreOwnComments: true,
    ignoreHandledComments: true
  }
}
```

## Trigger Rule

```js
{
  id: "rule-001",
  enabled: true,
  phrases: [
    "السعر",
    "بكام",
    "منين أجيب"
  ],
  matchMode: "contains",
  caseSensitive: false,
  responseStyle: "friendly"
}
```

## Comment

```js
{
  id: "platform-comment-id",
  author: "user-name",
  text: "بكام الكتاب؟",
  element: HTMLElement,
  metadata: {}
}
```

## Log

```js
{
  timestamp,
  site,
  commentId,
  commentText,
  matchedRule,
  generatedReply,
  status,
  error
}
```

---

# Core Flow

```text
New Comment
   ↓
Parse Comment
   ↓
Is Auto Reply ON?
   ├─ NO → Ignore
   └─ YES
       ↓
Already Handled?
   ├─ YES → Ignore
   └─ NO
       ↓
Matches Trigger?
   ├─ NO → Ignore
   └─ YES
       ↓
Queue
   ↓
Rate Limit / Delay
   ↓
Build Prompt
   ↓
LM Studio
   ↓
Validate Reply
   ├─ INVALID → Log Failed
   └─ VALID
       ↓
Open Reply UI
       ↓
Insert Text
       ↓
Submit
       ↓
Verify
   ├─ FAILED → Log Failed
   └─ SUCCESS
       ↓
Mark Handled
       ↓
Log Published
```

---

# Important Implementation Rules

## Rule 1 — Keep Core Separate From Website

الـ Core لا يعرف تفاصيل DOM الخاصة بالمنصة.

الـ Adapter هو المسؤول عن:

- Finding comments.
- Parsing comments.
- Finding Reply button.
- Opening Reply UI.
- Inserting text.
- Submitting.

---

## Rule 2 — Small Functions

يفضل أن تكون كل function مسؤولة عن شيء واحد.

بدل:

```js
processComment()
```

تكون هناك Functions أصغر مثل:

```js
parseComment()
matchesTrigger()
createPrompt()
generateReply()
validateReply()
findReplyButton()
submitReply()
markHandled()
```

---

## Rule 3 — Do Not Over-Engineer MVP

لا تضف في البداية:

- React إذا لم تكن هناك حاجة.
- Backend.
- Database server.
- WebSocket server.
- Authentication system.
- Complex build system.

Vanilla JS + MV3 كافية للنسخة الأولى.

---

## Rule 4 — One Feature At A Time

لا تطلب من الموديل تنفيذ مثلًا:

```text
Queue + Logs + Reply automation + UI redesign
```

في Prompt واحد.

الأفضل:

```text
Implement Task 10.1 only.
Do not modify unrelated files.
Then explain what changed and how to test it.
```

---

# Recommended Development Order

```text
Phase 0
  ↓
Phase 1
  ↓
Phase 2
  ↓
Phase 3
  ↓
Phase 4
  ↓
Phase 5
  ↓
Phase 6
  ↓
Phase 7
  ↓
Phase 8
  ↓
Phase 9
  ↓
Phase 10
  ↓
Phase 11
  ↓
Phase 12
  ↓
Phase 13
  ↓
Phase 14
  ↓
Phase 15
  ↓
Phase 16
  ↓
Phase 17
  ↓
Phase 18
  ↓
Phase 19 (optional)
```

---

# First Task To Give The Coding Model

ابدأ بهذا فقط:

```text
Read plan.md.

Implement PHASE 1 — Task 1.1 only.

Do not implement any other task.
Do not add extra features.
Create the project folder structure and the empty files specified by Task 1.1.

When finished:
1. List files created.
2. Do not modify unrelated files.
3. Stop and wait for the next task.
```

بعد نجاحها، انتقل إلى `Task 1.2` بنفس الأسلوب.
