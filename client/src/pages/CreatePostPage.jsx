import React, { useEffect, useMemo, useState } from 'react';
import {
  ImagePlus,
  Sparkles,
  Send,
  Clock3,
  Instagram,
  Youtube,
  AtSign,
  Plus,
  Trash2,
  SlidersHorizontal,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { aiApi, mediaApi, postsApi } from '../utils/api';
import { useAccounts } from '../contexts/AccountContext';

const platformLabel = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  threads: 'Threads',
};

const PLATFORM_CAPTION_LIMITS = {
  instagram: 2200,
  threads: 500,
  youtube: 5000,
};

const THREADS_POST_MAX_CHARS = 500;
const THREADS_AUTO_SPLIT_MAX_CHARS = 10000;
const THREADS_MAX_CHAIN_POSTS = 30;
const VIDEO_FILE_RE = /\.(mp4|mov|m4v|webm|avi|mpeg|mpg|mkv)(\?.*)?$/i;

const splitTextByLimit = (text, limit = THREADS_POST_MAX_CHARS) => {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  const parts = [];
  let remaining = normalized;
  const softFloor = Math.floor(limit * 0.55);

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit + 1);
    let cut = -1;

    const newlineCut = slice.lastIndexOf('\n');
    if (newlineCut >= softFloor) cut = newlineCut;

    if (cut < softFloor) {
      const sentenceCut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      if (sentenceCut >= softFloor) cut = sentenceCut + 1;
    }

    if (cut < softFloor) {
      const spaceCut = slice.lastIndexOf(' ');
      if (spaceCut >= softFloor) cut = spaceCut;
    }

    if (cut < softFloor) {
      cut = limit;
    }

    const part = remaining.slice(0, cut).trim();
    if (part) parts.push(part);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
};

const parseGeneratedThreadPosts = (rawText) => {
  const cleaned = String(rawText || '').replace(/\r/g, '\n').trim();
  if (!cleaned) return [];

  let parts = [];
  if (cleaned.includes('---')) {
    parts = cleaned.split(/\n?\s*---+\s*\n?/);
  } else if (/^\s*\d+[\).\s-]/m.test(cleaned)) {
    parts = cleaned.split(/\n(?=\s*\d+[\).\s-])/);
  } else {
    parts = cleaned.split(/\n{2,}/);
  }

  const normalized = parts
    .map((part) => part.replace(/^\s*\d+[\).\s-]+/, '').trim())
    .filter(Boolean)
    .flatMap((part) => splitTextByLimit(part, THREADS_POST_MAX_CHARS))
    .filter(Boolean);

  if (normalized.length >= 2) {
    return normalized.slice(0, THREADS_MAX_CHAIN_POSTS);
  }

  return splitTextByLimit(cleaned, THREADS_POST_MAX_CHARS).slice(0, THREADS_MAX_CHAIN_POSTS);
};

const CreatePostPage = () => {
  const { accounts } = useAccounts();

  const [caption, setCaption] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [mediaUrls, setMediaUrls] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkingPreflight, setCheckingPreflight] = useState(false);
  const [preflightIssues, setPreflightIssues] = useState([]);

  const [selectedPlatforms, setSelectedPlatforms] = useState({
    instagram: false,
    youtube: false,
    threads: false,
  });

  const [instagramType, setInstagramType] = useState('feed');
  const [youtubeType, setYoutubeType] = useState('video');
  const [threadsType, setThreadsType] = useState('text');
  const [threadsPosts, setThreadsPosts] = useState(['', '']);
  const [postMode, setPostMode] = useState('now');
  const [scheduledFor, setScheduledFor] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAiAssist, setShowAiAssist] = useState(false);

  const connectedPlatformSet = useMemo(
    () => new Set(accounts.map((account) => account.platform)),
    [accounts]
  );

  useEffect(() => {
    setSelectedPlatforms((prev) => {
      if (Object.values(prev).some(Boolean)) {
        return prev;
      }

      const next = {
        instagram: false,
        youtube: false,
        threads: false,
      };

      for (const account of accounts) {
        const platform = String(account?.platform || '').toLowerCase();
        if (platform in next) {
          next[platform] = true;
        }
      }

      return next;
    });
  }, [accounts]);

  const activePlatforms = useMemo(
    () => Object.keys(selectedPlatforms).filter((platform) => selectedPlatforms[platform]),
    [selectedPlatforms]
  );

  const disconnectedPlatforms = useMemo(
    () => activePlatforms.filter((platform) => !connectedPlatformSet.has(platform)),
    [activePlatforms, connectedPlatformSet]
  );

  const isThreadsThread = selectedPlatforms.threads && threadsType === 'thread';
  const isOnlyThreadsSingle =
    activePlatforms.length === 1 && selectedPlatforms.threads && !isThreadsThread;
  const showCaptionField =
    !isThreadsThread || activePlatforms.some((platform) => platform !== 'threads');
  const threadsTextAutoSplitEnabled = selectedPlatforms.threads && threadsType === 'text';
  const captionLabel = isOnlyThreadsSingle ? 'Post Text' : 'Caption';
  const captionPlaceholder = isOnlyThreadsSingle
    ? 'Write your Threads post text...'
    : 'Write your post caption...';

  const captionTargetPlatforms = useMemo(
    () =>
      activePlatforms.filter(
        (platform) => !(platform === 'threads' && (isThreadsThread || threadsTextAutoSplitEnabled))
      ),
    [activePlatforms, isThreadsThread, threadsTextAutoSplitEnabled]
  );

  const maxCaptionChars = useMemo(() => {
    const limits = captionTargetPlatforms
      .map((platform) => PLATFORM_CAPTION_LIMITS[platform])
      .filter((limit) => Number.isFinite(limit) && limit > 0);

    if (limits.length > 0) {
      return Math.min(...limits);
    }

    if (threadsTextAutoSplitEnabled) {
      return THREADS_AUTO_SPLIT_MAX_CHARS;
    }

    return PLATFORM_CAPTION_LIMITS.threads;
  }, [captionTargetPlatforms, threadsTextAutoSplitEnabled]);

  const estimatedThreadPosts = useMemo(() => {
    if (!threadsTextAutoSplitEnabled || !caption.trim()) {
      return 0;
    }
    return Math.max(1, Math.ceil(caption.trim().length / THREADS_POST_MAX_CHARS));
  }, [threadsTextAutoSplitEnabled, caption]);

  const mediaRequiredNow =
    postMode === 'now' &&
    (
      selectedPlatforms.instagram ||
      selectedPlatforms.youtube ||
      (selectedPlatforms.threads && !isThreadsThread && ['image', 'video'].includes(threadsType))
    );

  const hasVideoMedia = useMemo(
    () => mediaUrls.some((media) => VIDEO_FILE_RE.test(String(media?.url || ''))),
    [mediaUrls]
  );

  useEffect(() => {
    setPreflightIssues([]);
  }, [
    caption,
    mediaUrls,
    selectedPlatforms.instagram,
    selectedPlatforms.threads,
    selectedPlatforms.youtube,
    instagramType,
    youtubeType,
    threadsType,
    threadsPosts,
    postMode,
    scheduledFor,
  ]);

  const handlePlatformToggle = (platform) => {
    setSelectedPlatforms((prev) => ({
      ...prev,
      [platform]: !prev[platform],
    }));
  };

  const handleUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    try {
      const uploaded = [];

      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);

        const response = await mediaApi.upload(formData);
        if (response.data?.url) {
          uploaded.push({
            url: response.data.url,
            name: file.name,
          });
        }
      }

      setMediaUrls((prev) => [...prev, ...uploaded]);
      toast.success(`${uploaded.length} file(s) uploaded`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'File upload failed');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const handleGenerateCaption = async () => {
    const seedThreadText = threadsPosts.map((post) => post.trim()).filter(Boolean).join(' ');
    const prompt = aiPrompt.trim() || (isThreadsThread ? seedThreadText : caption.trim());
    if (!prompt) {
      toast.error('Enter a prompt first for AI caption generation');
      return;
    }

    if (activePlatforms.length === 0) {
      toast.error('Select at least one platform first');
      return;
    }

    setGenerating(true);
    try {
      const requestPrompt = isThreadsThread
        ? `${prompt}

Generate a Threads thread with 4 to 8 posts.
Rules:
- Each post must be <= ${THREADS_POST_MAX_CHARS} characters.
- Return ONLY thread posts separated by ---
- No headings, no numbering, no markdown, no extra commentary.`
        : prompt;

      const response = await aiApi.generateCaption({
        prompt: requestPrompt,
        platforms: isThreadsThread ? ['instagram'] : activePlatforms,
      });

      const generated = response.data?.caption || '';
      if (isThreadsThread) {
        const generatedPosts = parseGeneratedThreadPosts(generated);
        if (generatedPosts.length < 2) {
          toast.error('AI could not generate multiple thread posts. Try a more specific prompt.');
          return;
        }

        setThreadsPosts(generatedPosts);
        toast.success(`Thread generated (${generatedPosts.length} posts)`);
      } else {
        setCaption(generated.slice(0, maxCaptionChars));
        toast.success('Caption generated');
      }
    } catch (error) {
      toast.error(error.response?.data?.error || 'AI caption generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const removeMedia = (url) => {
    setMediaUrls((prev) => prev.filter((item) => item.url !== url));
  };

  const updateThreadPost = (index, value) => {
    setThreadsPosts((prev) => prev.map((item, idx) => (idx === index ? value : item)));
  };

  const addThreadPost = () => {
    setThreadsPosts((prev) => [...prev, '']);
  };

  const removeThreadPost = (index) => {
    setThreadsPosts((prev) => {
      if (prev.length <= 2) {
        return prev;
      }
      return prev.filter((_, idx) => idx !== index);
    });
  };

  const buildPostPayload = () => {
    const normalizedThreadPosts = threadsPosts
      .map((post) => post.trim())
      .filter(Boolean);

    return {
      caption,
      mediaUrls: mediaUrls.map((item) => item.url),
      platforms: activePlatforms,
      crossPost: activePlatforms.length > 1,
      instagramContentType: instagramType,
      youtubeContentType: youtubeType,
      threadsContentType: threadsType,
      threadsPosts: isThreadsThread ? normalizedThreadPosts : [],
      postNow: postMode === 'now',
      scheduledFor: postMode === 'schedule' && scheduledFor ? new Date(scheduledFor).toISOString() : null,
    };
  };

  const runPreflightChecks = async ({ showSuccessToast = false } = {}) => {
    const payload = buildPostPayload();

    setCheckingPreflight(true);
    try {
      const response = await postsApi.preflight(payload);
      const issues = response.data?.issues || [];
      setPreflightIssues(issues);

      if (issues.length > 0) {
        toast.error(issues[0]?.message || 'Preflight checks failed');
        return false;
      }

      if (showSuccessToast) {
        toast.success('Preflight checks passed');
      }
      return true;
    } catch (error) {
      const message = error.response?.data?.error || 'Failed to run preflight checks';
      toast.error(message);
      return false;
    } finally {
      setCheckingPreflight(false);
    }
  };

  const handleSubmit = async () => {
    if (activePlatforms.length === 0) {
      toast.error('Select at least one platform');
      return;
    }

    const normalizedThreadPosts = threadsPosts
      .map((post) => post.trim())
      .filter(Boolean);

    const needCaptionForPrimary = activePlatforms.some(
      (platform) => platform === 'instagram' || platform === 'youtube'
    );
    const needCaptionForThreadsSingle = selectedPlatforms.threads && !isThreadsThread;

    if ((needCaptionForPrimary || needCaptionForThreadsSingle) && !caption.trim()) {
      toast.error('Caption is required for selected platforms');
      return;
    }

    if (caption.trim() && caption.trim().length > maxCaptionChars) {
      toast.error(`Caption is too long. Max ${maxCaptionChars} chars for selected platforms.`);
      return;
    }

    if (isThreadsThread && normalizedThreadPosts.length < 2) {
      toast.error('Threads thread mode requires at least 2 posts');
      return;
    }

    if (postMode === 'now' && selectedPlatforms.instagram && mediaUrls.length === 0) {
      toast.error('Instagram posts need at least one media file');
      return;
    }

    if (
      postMode === 'now' &&
      selectedPlatforms.threads &&
      !isThreadsThread &&
      ['image', 'video'].includes(threadsType) &&
      mediaUrls.length === 0
    ) {
      toast.error('Threads image/video post needs media');
      return;
    }

    if (postMode === 'now' && selectedPlatforms.youtube && !hasVideoMedia) {
      toast.error('YouTube posts need at least one uploaded video file');
      return;
    }

    if (postMode === 'schedule' && !scheduledFor) {
      toast.error('Select a schedule date/time');
      return;
    }

    if (disconnectedPlatforms.length > 0) {
      toast.error(
        `Connect ${disconnectedPlatforms
          .map((platform) => platformLabel[platform])
          .join(', ')} first`
      );
      return;
    }

    const preflightOk = await runPreflightChecks({ showSuccessToast: false });
    if (!preflightOk) {
      return;
    }

    setSubmitting(true);
    try {
      await postsApi.create(buildPostPayload());

      toast.success(
        postMode === 'now' ? 'Post created successfully' : 'Post scheduled successfully'
      );
      setCaption('');
      setAiPrompt('');
      setMediaUrls([]);
      setThreadsPosts(['', '']);
      setPostMode('now');
      setScheduledFor('');
      setPreflightIssues([]);
    } catch (error) {
      const apiError = error.response?.data?.error;
      const apiCode = error.response?.data?.code;
      if (apiError && apiCode) {
        toast.error(`${apiError} (${apiCode})`);
      } else {
        toast.error(apiError || 'Failed to create post');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Create Post</h1>
        <p className="text-gray-600 mt-1">Simple flow: choose platforms, write, upload, publish.</p>
      </div>

      <div className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900">1. Choose Platforms</h2>
          <p className="text-xs text-gray-500">Cross-post is automatic when multiple are selected.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label
            className={`flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer ${
              selectedPlatforms.instagram
                ? 'border-blue-300 bg-blue-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
              <Instagram className="h-4 w-4 text-pink-600" />
              Instagram
            </span>
            <input
              type="checkbox"
              checked={selectedPlatforms.instagram}
              onChange={() => handlePlatformToggle('instagram')}
            />
          </label>

          <label
            className={`flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer ${
              selectedPlatforms.threads
                ? 'border-blue-300 bg-blue-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
              <AtSign className="h-4 w-4 text-slate-700" />
              Threads
            </span>
            <input
              type="checkbox"
              checked={selectedPlatforms.threads}
              onChange={() => handlePlatformToggle('threads')}
            />
          </label>

          <label
            className={`flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer ${
              selectedPlatforms.youtube
                ? 'border-blue-300 bg-blue-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
              <Youtube className="h-4 w-4 text-red-600" />
              YouTube
            </span>
            <input
              type="checkbox"
              checked={selectedPlatforms.youtube}
              onChange={() => handlePlatformToggle('youtube')}
            />
          </label>
        </div>

        {disconnectedPlatforms.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            Connect {disconnectedPlatforms.map((platform) => platformLabel[platform]).join(', ')} in{' '}
            <a href="/accounts" className="font-semibold underline">
              Connected Accounts
            </a>{' '}
            first.
          </div>
        )}
      </div>

      <div className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900">2. Write Content</h2>
          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          </button>
        </div>

        {selectedPlatforms.threads && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Threads Post Mode</label>
            <select
              className="input"
              value={threadsType}
              onChange={(event) => setThreadsType(event.target.value)}
            >
              <option value="text">Single Post (Text)</option>
              <option value="image">Single Post (Image)</option>
              <option value="video">Single Post (Video)</option>
              <option value="thread">Thread (Multiple Posts)</option>
            </select>
          </div>
        )}

        {showAdvanced && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            {selectedPlatforms.instagram && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Instagram Type</label>
                <select
                  className="input"
                  value={instagramType}
                  onChange={(event) => setInstagramType(event.target.value)}
                >
                  <option value="feed">Feed</option>
                  <option value="reel">Reel</option>
                  <option value="story">Story</option>
                  <option value="carousel">Carousel</option>
                </select>
              </div>
            )}

            {selectedPlatforms.youtube && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">YouTube Type</label>
                <select
                  className="input"
                  value={youtubeType}
                  onChange={(event) => setYoutubeType(event.target.value)}
                >
                  <option value="video">Video</option>
                  <option value="short">Short</option>
                </select>
              </div>
            )}
          </div>
        )}

        {showCaptionField && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{captionLabel}</label>
            <textarea
              className="textarea min-h-0"
              rows={5}
              placeholder={captionPlaceholder}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              maxLength={maxCaptionChars}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
              <p className="text-xs text-gray-500">{caption.length}/{maxCaptionChars} characters</p>
              {isOnlyThreadsSingle && (
                <p className="text-xs text-gray-500">
                  This text is posted directly to Threads.
                </p>
              )}
              {threadsTextAutoSplitEnabled && caption.trim().length > THREADS_POST_MAX_CHARS && (
                <p className="text-xs text-gray-500">
                  Long text will auto-split into a Threads chain (~{estimatedThreadPosts} posts).
                </p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowAiAssist((prev) => !prev)}
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
          >
            <Sparkles className="h-4 w-4" />
            {showAiAssist ? 'Hide AI assist' : 'Use AI assist'}
          </button>

          {showAiAssist && (
            <div className="space-y-2">
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  className="input"
                  placeholder={isThreadsThread
                    ? 'Describe your thread topic, angle, and CTA'
                    : 'Describe tone, audience, and offer'}
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary px-4"
                  onClick={handleGenerateCaption}
                  disabled={generating}
                >
                  <Sparkles className="h-4 w-4 mr-2" />
                  {generating ? 'Generating...' : isThreadsThread ? 'Generate Thread' : 'Generate'}
                </button>
              </div>
              {isThreadsThread && (
                <p className="text-xs text-gray-500">
                  AI will fill the thread posts below. Edit any post before publishing.
                </p>
              )}
            </div>
          )}
        </div>

        {isThreadsThread && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Threads Chain (2+ posts)</h3>
              <button
                type="button"
                className="text-sm text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                onClick={addThreadPost}
              >
                <Plus className="h-4 w-4" />
                Add Post
              </button>
            </div>

            <div className="space-y-2">
              {threadsPosts.map((post, index) => (
                <div key={`thread-post-${index}`} className="flex gap-2">
                  <div className="w-full">
                    <textarea
                      className="textarea min-h-0"
                      rows={3}
                      placeholder={`Thread post ${index + 1}`}
                      value={post}
                      onChange={(event) =>
                        updateThreadPost(
                          index,
                          event.target.value.slice(0, THREADS_POST_MAX_CHARS)
                        )
                      }
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {post.length}/{THREADS_POST_MAX_CHARS}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="self-start mt-1 text-red-600 hover:text-red-700 disabled:opacity-40"
                    onClick={() => removeThreadPost(index)}
                    disabled={threadsPosts.length <= 2}
                    title="Remove post"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">3. Upload Media</h2>
        <p className="text-sm text-gray-500">
          {mediaRequiredNow
            ? 'Media is required for your current post settings.'
            : 'Media is optional for your current post settings.'}
        </p>

        <label className="flex items-center justify-center w-full rounded-lg border-2 border-dashed border-gray-300 p-6 cursor-pointer hover:border-blue-400">
          <div className="text-center">
            <ImagePlus className="h-7 w-7 text-gray-500 mx-auto mb-2" />
            <p className="text-sm text-gray-600">Click to select files (supports image/video)</p>
          </div>
          <input
            type="file"
            className="hidden"
            accept="image/*,video/*"
            multiple
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>

        {uploading && <p className="text-sm text-gray-500">Uploading media...</p>}

        {mediaUrls.length > 0 && (
          <div className="space-y-2">
            {mediaUrls.map((media) => (
              <div
                key={media.url}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2"
              >
                <span className="text-sm text-gray-700 truncate mr-4">{media.name}</span>
                <button
                  type="button"
                  onClick={() => removeMedia(media.url)}
                  className="text-xs text-red-600 hover:text-red-700"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">4. Publish</h2>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={postMode === 'now'} onChange={() => setPostMode('now')} />
            <Send className="h-4 w-4" />
            Post now
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={postMode === 'schedule'}
              onChange={() => setPostMode('schedule')}
            />
            <Clock3 className="h-4 w-4" />
            Schedule
          </label>
        </div>

        {postMode === 'schedule' && (
          <input
            type="datetime-local"
            className="input"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
          />
        )}

        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600 space-y-1">
          <p>
            <span className="font-medium text-gray-800">Platforms:</span>{' '}
            {activePlatforms.length > 0
              ? activePlatforms.map((platform) => platformLabel[platform]).join(', ')
              : 'None selected'}
          </p>
          <p>
            <span className="font-medium text-gray-800">Cross-post:</span>{' '}
            {activePlatforms.length > 1 ? 'Yes' : 'No'}
          </p>
          <p>
            <span className="font-medium text-gray-800">Media files:</span> {mediaUrls.length}
          </p>
        </div>

        <button
          type="button"
          className="w-full h-10 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={checkingPreflight || uploading || submitting}
          onClick={() => runPreflightChecks({ showSuccessToast: true })}
        >
          {checkingPreflight ? 'Running checks...' : 'Run Preflight Checks'}
        </button>

        {preflightIssues.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-1">
            <p className="text-sm font-medium text-red-800">Fix these before posting:</p>
            <ul className="list-disc pl-5 text-xs text-red-700 space-y-1">
              {preflightIssues.map((issue, index) => (
                <li key={`${issue.code || 'ISSUE'}-${index}`}>
                  {issue.message} {issue.code ? `(${issue.code})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary w-full h-10"
          disabled={submitting || uploading}
          onClick={handleSubmit}
        >
          {submitting ? 'Submitting...' : postMode === 'now' ? 'Post Now' : 'Schedule Post'}
        </button>
      </div>
    </div>
  );
};

export default CreatePostPage;
