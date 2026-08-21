import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';
import {
  FeedbackModal,
  isFeedbackSubmitShortcut,
  validateFeedbackAttachmentSelection,
  validateFeedbackEmail,
} from './FeedbackModal';
import {
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_IMAGES,
} from '../../../shared/feedback';

test('validates optional contact email', () => {
  assert.equal(validateFeedbackEmail(''), null);
  assert.equal(validateFeedbackEmail('person@example.com'), null);
  assert.match(validateFeedbackEmail('not-an-email') ?? '', /valid contact email/);
});

test('validates attachment type, count, and total size', () => {
  assert.match(validateFeedbackAttachmentSelection([], [{ size: 1, type: 'image/gif' }]) ?? '', /JPEG/);
  assert.match(validateFeedbackAttachmentSelection(
    Array.from({ length: FEEDBACK_MAX_IMAGES }, () => ({ size: 1 })),
    [{ size: 1, type: 'image/png' }],
  ) ?? '', /no more than 10/);
  assert.match(validateFeedbackAttachmentSelection([], [{
    size: FEEDBACK_MAX_ATTACHMENT_BYTES + 1,
    type: 'image/webp',
  }]) ?? '', /8 MiB/);
  assert.equal(validateFeedbackAttachmentSelection([], [{ size: 1, type: 'image/jpeg' }]), null);
});

test('recognizes enabled Cmd/Ctrl+Enter submission shortcuts', () => {
  assert.equal(isFeedbackSubmitShortcut({ ctrlKey: true, key: 'Enter', metaKey: false }, true), true);
  assert.equal(isFeedbackSubmitShortcut({ ctrlKey: false, key: 'Enter', metaKey: true }, true), true);
  assert.equal(isFeedbackSubmitShortcut({ ctrlKey: true, key: 'Enter', metaKey: false }, false), false);
  assert.equal(isFeedbackSubmitShortcut({ ctrlKey: true, key: 'Space', metaKey: false }, true), false);
});

test('renders the accessible Emdash-inspired feedback form', () => {
  const markup = renderToStaticMarkup(
    <FeedbackModal
      configured
      isOpen
      onClose={() => {}}
      onSubmitted={() => {}}
    />,
  );
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-labelledby="[^"]+"/);
  assert.match(markup, /<h2[^>]*>Feedback<\/h2>/);
  assert.match(markup, /Feedback details/);
  assert.match(markup, /Contact email/);
  assert.match(markup, /Include diagnostic logs/);
  assert.match(markup, /Attach image/);
  assert.match(markup, /Send Feedback/);
  assert.match(markup, /disabled=""/);
});
