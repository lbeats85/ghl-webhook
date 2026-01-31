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

    // Step 1: Get contact from GoHighLevel to retrieve Stripe Customer ID
    console.log(`Getting contact from GoHighLevel: ${customerId}`);
    const contact = await getGHLContact(customerId);
    
    if (!contact) {
      console.error(`Contact not found: ${customerId}`);
      return res.status(404).json({ 
        success: false, 
        error: 'Contact not found in GoHighLevel' 
      });
    }

    // Get Stripe Customer ID from custom field
    const stripeCustomerId = contact.customFields?.find(
      field => field.id === 'Stripe Customer Id' || field.key === 'stripe_customer_id'
    )?.value || contact['Stripe Customer Id'];

    if (!stripeCustomerId) {
      console.error('Stripe Customer ID not found in contact custom fields');
      console.log('Available custom fields:', JSON.stringify(contact.customFields, null, 2));
      return res.status(404).json({ 
        success: false, 
        error: 'Stripe Customer ID not found in GoHighLevel contact. Please ensure the "Stripe Customer Id" custom field is populated.' 
      });
    }

    console.log(`Stripe Customer ID: ${stripeCustomerId}`);

    // Step 2: Get subscriptions from Stripe for this customer
    console.log(`Getting subscriptions from Stripe for customer: ${stripeCustomerId}`);
    const subscriptions = await getStripeSubscriptions(stripeCustomerId);
    
    if (!subscriptions || subscriptions.length === 0) {
      console.log('No subscriptions found in Stripe');
      return res.status(404).json({ 
        success: false, 
        error: 'No subscriptions found for this customer in Stripe' 
      });
    }

    console.log(`Found ${subscriptions.length} subscription(s) in Stripe`);

    // Step 3: Cancel subscriptions that are active, trialing, past_due, unpaid, or incomplete
    const results = [];
    for (const sub of subscriptions) {
      const shouldCancel = 
        sub.status === 'active' || 
        sub.status === 'trialing' || 
        sub.status === 'past_due' || 
        sub.status === 'unpaid' ||
        sub.status === 'incomplete';
      
      if (shouldCancel) {
        console.log(`Attempting to cancel Stripe subscription ${sub.id} (status: ${sub.status})`);
        const cancelResult = await cancelStripeSubscription(sub.id);
        results.push({
          subscriptionId: sub.id,
          status: sub.status,
          ...cancelResult
        });
      } else {
        console.log(`Skipping subscription ${sub.id} (status: ${sub.status} - already canceled or ended)`);
      }
    }

    if (results.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No active subscriptions to cancel',
        totalSubscriptions: subscriptions.length,
        canceledCount: 0
      });
    }

    // Step 4: Return results
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
      stripeCustomerId: stripeCustomerId,
      totalSubscriptions: subscriptions.length,
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
 * Get contact details from GoHighLevel
 */
async function getGHLContact(contactId) {
  try {
    const response = await axios.get(
      `${GHL_API_V2}/contacts/${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('GoHighLevel contact retrieved');
    return response.data.contact;
  } catch (error) {
    console.error('Error getting GHL contact:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get all subscriptions for a Stripe customer
 */
async function getStripeSubscriptions(stripeCustomerId) {
  try {
    console.log(`Calling Stripe API to get subscriptions for: ${stripeCustomerId}`);
    
    const response = await axios.get(
      `${STRIPE_API}/subscriptions`,
      {
        headers: {
          'Authorization': `Bearer ${STRIPE_API_KEY}`
        },
        params: {
          customer: stripeCustomerId,
          limit: 100
        }
      }
    );
    
    console.log(`Found ${response.data.data.length} subscription(s) in Stripe`);
    return response.data.data;
  } catch (error) {
    console.error('Error getting Stripe subscriptions:', error.response?.data || error.message);
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
      '2. Fetches contact from GoHighLevel',
      '3. Extracts Stripe Customer ID from custom field',
      '4. Gets all subscriptions from Stripe for that customer',
      '5. Cancels active/past_due/unpaid subscriptions in Stripe',
      '6. Returns cancellation results'
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
