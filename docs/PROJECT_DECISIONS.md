# Project Decisions

## Target Platform

TARGET_PLATFORM=youtube

Reason: YouTube is a highly popular platform with extensive comment sections, making it ideal for an AI auto-reply extension. It has well-documented APIs and is widely used by content creators where automated engagement tools are common.

## MVP Scope

### Included
- Chrome Extension using Manifest V3
- Connection to the local LM Studio API
- User-defined trigger keywords/phrases
- Comment detection
- Trigger matching
- Sending the matched comment to LM Studio
- Generating an AI reply
- Inserting the generated reply into the website
- Publishing the reply
- Preventing duplicate replies to the same comment
- Basic logging
- Basic rate limiting

### Excluded
- Support for multiple platforms
- Cloud backend
- RAG (Retrieval-Augmented Generation)
- Image understanding
- Multi-account management
- CAPTCHA bypass
- Anti-bot protection bypass
- Large-scale spam automation
- Any feature that is not required for the MVP to work

## Architecture Constraint

The MVP supports one platform only.

Core logic must remain separated from platform-specific logic.

## Safety Constraint

The extension must not bypass CAPTCHA, anti-bot protections, or platform security mechanisms.
