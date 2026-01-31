const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration from environment variables
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const STRIPE_API_KEY = process.env.STRIPE_API_KEY;
const PORT = process.env.PORT || 3000;

// API Base URLs
const GHL_API_V2 = 'https://services.leadconnectorhq.com';
const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Main webhook endpoint for subscription cancellation
 */
app.post('/webhook/cancel-subscription', async (req, res) => {
  try {
    console.log('=== New Webhook Request ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    const { customerId } = req.body;
    
    // Validate input
    if (!customerId) {
      console.error('Missing customerId in request');
      return res.status(400).json({ 
        success: false, 
        error: 'customerId is required in the request body' 
      });
    }

    // Step 1: Get subscriptions from GoHighLevel
    console.log(`Getting subscriptions from GoHighLevel for customer: ${customerId}`);
    const ghlSubscriptions = await getGHLSubscriptions(customerId);
    
    if (!ghlSubscriptions || ghlSubscriptions.length === 0) {
      console.log('No subscriptions found in GoHighLevel');
      return res.status(404).json({ 
        success: false, 
        error: 'No subscriptions found for this customer in GoHighLevel' 
      });
    }

    console.log(`Found ${ghlSubscriptions.length} subscription(s) in GoHighLevel`);

    // Step 2: Cancel subscriptions in Stripe using IDs from GoHighLevel
    const results = [];
    for (const sub of ghlSubscriptions) {
      // Check if subscription should be canceled based on status
      const shouldCancel = 
        sub.status === 'active' || 
        sub.status === 'trialing' || 
        sub.status === 'past_due' || 
        sub.status === 'unpaid' ||
        sub.status === 'incomplete';
      
      if (shouldCancel && sub.entityId) {
        console.log(`Attempting to cancel Stripe subscription ${sub.entityId} (GHL status: ${sub.status})`);
        const cancelResult = await cancelStripeSubscription(sub.entityId);
        results.push({
          ghlSubscriptionId: sub.id,
          stripeSubscriptionId: sub.entityId,
          status: sub.status,
          ...cancelResult
        });
      } else {
        console.log(`Skipping subscription ${sub.id} (status: ${sub.status}, has entityId: ${!!sub.entityId})`);
      }
    }

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No cancellable subscriptions found',
        totalSubscriptions: ghlSubscriptions.length
      });
    }

    // Step 3: Return results
    const allSuccessful = results.every(r => r.success);
    console.log('=== Cancellation Complete ===');
    console.log(`Success: ${allSuccessful}`);
    console.log(`Canceled: ${results.filter(r => r.success).length}/${results.length}`);

    return res.status(allSuccessful ? 200 : 207).json({
      success: allSuccessful,
      message: allSuccessful ? 
        'All subscriptions canceled successfully' : 
        'Some subscriptions failed to cancel',
      customerId: customerId,
      totalSubscriptions: ghlSubscriptions.length,
      canceledCount: results.filter(r => r.success).length,
      results: results
    });

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * Get subscriptions from GoHighLevel for a customer
 */
async function getGHLSubscriptions(customerId) {
  try {
    const response = await axios.get(
      `${GHL_API_V2}/payments/subscriptions`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        },
        params: {
          altId: customerId,
          altType: 'contact'
        }
      }
    );
    
    console.log('GoHighLevel subscriptions response:', JSON.stringify(response.data, null, 2));
    return response.data.subscriptions || [];
  } catch (error) {
    console.error('Error getting GHL subscriptions:', error.response?.data || error.message);
    
    // If 403 Forbidden, the API key doesn't have permissions
    if (error.response?.status === 403) {
      throw new Error('GoHighLevel API key does not have permission to access subscriptions. Please check your Private Integration scopes.');
    }
    
    throw error;
  }
}

/**
 * Cancel a Stripe subscription
 */
async function cancelStripeSubscription(subscriptionId) {
  try {
    console.log(`Calling Stripe API to cancel subscription: ${subscriptionId}`);
    
    const response = await axios.delete(
      `${STRIPE_API}/subscriptions/${subscriptionId}`,
      {
        headers: {
          'Authorization': `Bearer ${STRIPE_API_KEY}`
        }
      }
    );
    
    console.log(`✓ Successfully canceled Stripe subscription ${subscriptionId}`);
    console.log('Stripe response:', JSON.stringify(response.data, null, 2));
    
    return {
      success: true,
      message: 'Subscription canceled successfully in Stripe',
      canceledAt: new Date().toISOString(),
      stripeStatus: response.data.status
    };
  } catch (error) {
    console.error(`✗ Failed to cancel Stripe subscription ${subscriptionId}:`, 
      error.response?.data || error.message);
    
    return {
      success: false,
      message: error.response?.data?.error?.message || error.message,
      errorCode: error.response?.status,
      errorType: error.response?.data?.error?.type
    };
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    service: 'GHL + Stripe Subscription Cancellation',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    integrations: {
      goHighLevel: !!GHL_API_KEY,
      stripe: !!STRIPE_API_KEY
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'GoHighLevel + Stripe Subscription Cancellation Webhook',
    endpoints: {
      health: 'GET /health',
      webhook: 'POST /webhook/cancel-subscription'
    },
    webhookPayload: {
      required: ['customerId'],
      example: {
        customerId: 'contact_id_from_ghl'
      }
    },
    workflow: [
      '1. Receives GoHighLevel contact ID',
      '2. Fetches subscriptions from GoHighLevel',
      '3. Extracts Stripe subscription IDs from GoHighLevel data',
      '4. Cancels subscriptions directly in Stripe',
      '5. Returns cancellation results'
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log('=========================================');
  console.log('GHL + Stripe Subscription Cancellation');
  console.log('=========================================');
  console.log(`Status: Running`);
  console.log(`Port: ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook/cancel-subscription`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log('=========================================');
  console.log('API Configuration:');
  console.log(`  GoHighLevel: ${GHL_API_KEY ? '✓' : '✗'}`);
  console.log(`  Stripe: ${STRIPE_API_KEY ? '✓' : '✗'}`);
  console.log('=========================================');
  console.log('Waiting for webhooks...');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
