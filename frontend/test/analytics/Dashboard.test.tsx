import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../../src/features/analytics/pages/Dashboard';
import { API_BASE_URL } from '../../src/config/constants';
import { renderWithProviders } from '../renderWithProviders';
import { server } from '../msw/server';
import { ADMIN_DASHBOARD_REFRESH_INTERVAL_MS } from '../../src/features/analytics/hooks/useAdminDashboard';

const capabilities = {
  completion: true,
  streaming: true,
  reasoning: true,
  modelListing: true,
  modelPulling: false,
  embeddings: true,
  toolCalling: false,
  structuredOutput: false,
  tokenCounting: false,
};

const summary = {
  period: {
    from: null,
    to: null,
  },
  providers: {
    total: 1,
    active: 1,
    disabled: 0,
  },
  users: {
    total: 2,
    active: 2,
    banned: 0,
    deleted: 0,
    review: 0,
  },
  generation: {
    total: 5,
    succeeded: 4,
    failed: 1,
    aborted: 0,
    successRate: 0.8,
    failureRate: 0.2,
    abortRate: 0,
    averageLatencyMs: 120,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  },
  jobs: {
    total: 3,
    current: {
      queued: 1,
      running: 1,
      cancelRequested: 0,
      cancelled: 0,
      succeeded: 1,
      failed: 0,
    },
    finalized: {
      total: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    },
    averageQueueWaitMs: 10,
    averageExecutionDurationMs: 250,
    averageAttempts: 1,
  },
  providerHealth: {
    total: 2,
    success: 2,
    error: 0,
    skipped: 0,
    errorRate: 0,
    averageLatencyMs: 25,
    latestSampleAt: '2026-08-14T12:00:00.000Z',
  },
};

function registerDashboardHandlers(onSummaryRequest?: (url: URL) => void) {
  server.use(
    http.get(`${API_BASE_URL}/admin/analytics/summary`, ({ request }) => {
      onSummaryRequest?.(new URL(request.url));
      return HttpResponse.json({ data: summary });
    }),
    http.get(`${API_BASE_URL}/admin/system/status`, () =>
      HttpResponse.json({
        data: {
          backend: { status: 'online' },
          database: { status: 'online' },
          inference: {
            status: 'online',
            providers: 1,
            errors: 0,
            skipped: 0,
          },
        },
      }),
    ),
    http.get(`${API_BASE_URL}/admin/llm/providers`, () =>
      HttpResponse.json({
        data: [
          {
            id: 1,
            name: 'Analytics Provider',
            type: 'openai-compatible',
            baseUrl: 'https://provider.example.com',
            enabled: true,
            defaultModel: 'analytics-model',
            timeoutMs: 5000,
            generationDefaults: {},
            capabilities,
            extraHeaders: {},
            hasApiKey: true,
            deletedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ),
    http.get(`${API_BASE_URL}/llm/models`, () =>
      HttpResponse.json({
        data: {
          models: [
            {
              providerId: '1',
              providerName: 'Analytics Provider',
              providerType: 'openai-compatible',
              modelId: 'analytics-model',
              modelName: 'analytics-model',
              capabilities: {
                completion: 'UNKNOWN',
                streaming: 'UNKNOWN',
                reasoning: 'UNKNOWN',
                embeddings: 'UNKNOWN',
                toolCalling: 'UNKNOWN',
                structuredOutput: 'UNKNOWN',
                tokenCounting: 'UNKNOWN',
              },
            },
          ],
          providers: [
            {
              providerId: '1',
              providerName: 'Analytics Provider',
              providerType: 'openai-compatible',
              status: 'success',
              modelCount: 1,
              capabilities,
            },
          ],
        },
      }),
    ),
    http.get(`${API_BASE_URL}/users`, () =>
      HttpResponse.json({
        data: [
          {
            id: 1,
            name: 'Admin User',
            email: 'admin@example.com',
            role: 'ADMIN',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
}

describe('Dashboard analytics summary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders operational aggregates and sends optional date-window params', async () => {
    const summaryRequests: URL[] = [];
    registerDashboardHandlers((url) => summaryRequests.push(url));

    renderWithProviders(<Dashboard />, {
      initialEntries: ['/analytics/dashboard'],
      routePath: '/analytics/dashboard',
    });

    expect(await screen.findByText('Generations')).toBeInTheDocument();
    expect(await screen.findByText('80% success, 0% aborted')).toBeInTheDocument();
    expect(await screen.findByText('Generation Usage')).toBeInTheDocument();
    expect(await screen.findByText('Job Operations')).toBeInTheDocument();
    expect(await screen.findByText('Provider Samples')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('From'), '2026-08-14T00:00');
    await userEvent.type(screen.getByLabelText('To'), '2026-08-15T00:00');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findAllByText('Analytics Provider')).not.toHaveLength(0);
    expect(summaryRequests.some((url) => (
      url.searchParams.has('from') && url.searchParams.has('to')
    ))).toBe(true);
  });

  it('manually refreshes operational analytics', async () => {
    const summaryRequests: URL[] = [];
    registerDashboardHandlers((url) => summaryRequests.push(url));

    renderWithProviders(<Dashboard />, {
      initialEntries: ['/analytics/dashboard'],
      routePath: '/analytics/dashboard',
    });

    expect(await screen.findByText('Generations')).toBeInTheDocument();

    const refreshButton = screen.getByRole('button', {
      name: 'Refresh operational analytics',
    });
    await waitFor(() => expect(refreshButton).toBeEnabled());

    const initialRequestCount = summaryRequests.length;
    await userEvent.click(refreshButton);

    await waitFor(() => {
      expect(summaryRequests.length).toBeGreaterThan(initialRequestCount);
    });
  });

  it('auto-refreshes operational analytics on a conservative interval', async () => {
    vi.useFakeTimers();
    const summaryRequests: URL[] = [];
    registerDashboardHandlers((url) => summaryRequests.push(url));

    renderWithProviders(<Dashboard />, {
      initialEntries: ['/analytics/dashboard'],
      routePath: '/analytics/dashboard',
    });

    await vi.waitFor(() => {
      expect(screen.getByText('80% success, 0% aborted')).toBeInTheDocument();
    });
    const initialRequestCount = summaryRequests.length;

    await vi.advanceTimersByTimeAsync(ADMIN_DASHBOARD_REFRESH_INTERVAL_MS);

    await vi.waitFor(() => {
      expect(summaryRequests.length).toBeGreaterThan(initialRequestCount);
    });
  });
});
