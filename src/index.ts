
import express from 'express';
import { SmartDialer } from './core/SmartDialer';
import { DialMode } from './types';

const app = express();
app.use(express.json({ limit: '1mb' }));

const dialer = new SmartDialer();

// Root route: API information
app.get('/', (_req, res) => {
  res.json({
    name: 'SmartDialer API',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      seed: 'POST /api/seed',
      dial: 'POST /api/dial',
      metrics: 'GET /api/metrics',
      state: 'GET /api/state',
      updateAgentState: 'PATCH /api/agents/:id/state',
      providerEvent: 'POST /api/providers/:provider/events',
    },
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'smart-dialer',
    timestamp: new Date().toISOString(),
  });
});

// Seed agents and borrowers
app.post('/api/seed', async (req, res, next) => {
  try {
    const agents = Number(req.body?.agents ?? 10);
    const borrowers = Number(req.body?.borrowers ?? 100);
    const campaignId = String(req.body?.campaignId ?? 'default').trim();

    if (!campaignId) {
      res.status(400).json({ error: 'campaignId cannot be empty' });
      return;
    }

    if (
      !Number.isInteger(agents) ||
      agents < 0 ||
      agents > 10000 ||
      !Number.isInteger(borrowers) ||
      borrowers < 0 ||
      borrowers > 100000
    ) {
      res.status(400).json({
        error:
          'agents must be 0..10000 and borrowers 0..100000 integers',
      });
      return;
    }

    await dialer.seed(agents, borrowers, campaignId);

    res.status(201).json({
      message: 'seeded',
      agents,
      borrowers,
      campaignId,
    });
  } catch (error) {
    next(error);
  }
});

// Dial a campaign
app.post('/api/dial', async (req, res, next) => {
  try {
    const campaignId = String(req.body?.campaignId ?? 'default').trim();
    if (!campaignId) {
      res.status(400).json({ error: 'campaignId cannot be empty' });
      return;
    }

    const mode = String(
      req.body?.mode ?? 'PROGRESSIVE',
    ).toUpperCase() as DialMode;

    const requested =
      req.body?.requestedCalls === undefined
        ? undefined
        : Number(req.body.requestedCalls);

    const answerRate =
      req.body?.historicalAnswerRate === undefined
        ? 0.5
        : Number(req.body.historicalAnswerRate);

    if (!['PROGRESSIVE', 'PREDICTIVE'].includes(mode)) {
      res.status(400).json({
        error: 'mode must be PROGRESSIVE or PREDICTIVE',
      });
      return;
    }

    if (
      requested !== undefined &&
      (!Number.isInteger(requested) ||
        requested < 0 ||
        requested > 10000)
    ) {
      res.status(400).json({
        error: 'requestedCalls must be an integer from 0 to 10000',
      });
      return;
    }

    if (
      !Number.isFinite(answerRate) ||
      answerRate < 0 ||
      answerRate > 1
    ) {
      res.status(400).json({
        error: 'historicalAnswerRate must be between 0 and 1',
      });
      return;
    }

    const result = await dialer.dial(
      campaignId,
      mode,
      requested,
      answerRate,
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Current metrics
app.get('/api/metrics', async (_req, res, next) => {
  try {
    res.json(await dialer.metrics());
  } catch (error) {
    next(error);
  }
});

// Current system state
app.get('/api/state', async (_req, res, next) => {
  try {
    res.json(await dialer.state.snapshot());
  } catch (error) {
    next(error);
  }
});

// Update an agent's state
app.patch('/api/agents/:id/state', async (req, res, next) => {
  try {
    const allowed = [
      'OFFLINE',
      'AVAILABLE',
      'RESERVED',
      'DIALING',
      'CONNECTED',
      'WRAP_UP',
      'PAUSED',
    ];

    const state = String(req.body?.state ?? '').toUpperCase();

    if (!allowed.includes(state)) {
      res.status(400).json({
        error: `state must be one of ${allowed.join(', ')}`,
      });
      return;
    }

    const ok = await dialer.state.setAgentState(
      req.params.id,
      state as
        | 'OFFLINE'
        | 'AVAILABLE'
        | 'RESERVED'
        | 'DIALING'
        | 'CONNECTED'
        | 'WRAP_UP'
        | 'PAUSED',
    );

    if (!ok) {
      res.status(409).json({
        updated: false,
        error: 'agent not found or transition not allowed',
      });
      return;
    }

    res.json({ updated: true });
  } catch (error) {
    next(error);
  }
});

// Receive provider events
app.post(
  '/api/providers/:provider/events',
  async (req, res, next) => {
    try {
      const body = req.body ?? {};

      const validTypes = [
        'RINGING',
        'ANSWERED',
        'CONNECTED',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
      ];

      if (
        typeof body.eventId !== 'string' || !body.eventId.trim() ||
        typeof body.callId !== 'string' || !body.callId.trim() ||
        !validTypes.includes(body.type)
      ) {
        res.status(400).json({
          error: 'eventId, callId and valid type are required',
        });
        return;
      }

      const occurredAt = Number(
        body.occurredAt ?? Date.now(),
      );

      if (!Number.isFinite(occurredAt)) {
        res.status(400).json({
          error: 'occurredAt must be a valid number',
        });
        return;
      }

      const result = await dialer.handleProviderEvent({
        eventId: body.eventId.trim(),
        callId: body.callId.trim(),
        type: body.type,
        occurredAt,
        provider: String(req.params.provider),
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// JSON 404 for unknown routes
app.use((_req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: 'Check the API endpoint and HTTP method.',
  });
});

// Central error handler
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('API error:', error);

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      error: 'Internal server error',
    });
  },
);

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(
    `SmartDialer API listening on http://localhost:${port}`,
  );
});
