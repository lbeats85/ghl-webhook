const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration from environment variables
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const PORT = process.env.PORT || 3000;

// GoHighLevel API v2 Base URL
const GHL_API_V2 = 'https://services.leadconnectorhq.com';

/**
 * Main webhook endpoint for subscription cancellation
 */
app.post('/webhook/cancel-subscription', async (req, res) => {
  try {
    console.log('=== New Webhook Request ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    const { customerId, subscriptionId } = req.body;
    
    // Validate input
    if (!customerId) {
      console.error('Missing customerId in request');
      return res.status(400).json({ 
        success: false, 
        error: 'customerId is required in the request body' 
      });
    }

    // If specific subscription ID is provided, cancel only that one
    if (subscriptionId) {
      console.log(`Canceling specific subscription: ${subscriptionId}`);
      const result = await cancelSingleSubscription(subscriptionId);
      
      return res.status(result.success ? 200 : 500).json({
        success: result.success,
        message: result.message,
        customerId: customerId,
        subscriptionId: subscriptionId
      });
    }

    // Otherwise, find and cancel all subscriptions for the customer
    console.log(`Finding all subscriptions for customer: ${customerId}`);
    
    // Step 1: Verify customer exists
    const customerExists = await verifyCustomer(customerId);
    if (!customerExists) {
      console.error(`Customer not found: ${customerId}`);
      return res.status(404).json({ 
        success: false, 
        error: 'Customer not found in GoHighLevel' 
      });
    }

    // Step 2: Get subscriptions
    const subscriptions = await getSubscriptionsByCustomer(customerId);
    
    if (!subscriptions || subscriptions.length === 0) {
      console.log('No subscriptions found');
      return res.status(404).json({ 
        success: false, 
        error: 'No subscriptions found for this customer' 
      });
    }

    console.log(`Found ${subscriptions.length} subscription(s)`);

    // Step 3: Cancel all active, trialing, past_due, and unpaid subscriptions
    const results = [];
    for (const sub of subscriptions) {
      if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due' || sub.status === 'unpaid') {
        console.log(`Attempting to cancel subscription ${sub.id} (status: ${sub.status})`);
        const cancelResult = await cancelSingleSubscription(sub.id);
        results.push({
          subscriptionId: sub.id,
          status: sub.status,
          ...cancelResult
        });
      } else {
        console.log(`Skipping subscription ${sub.id} (status: ${sub.status})`);
      }
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
 * Verify customer exists in GoHighLevel
 */
async function verifyCustomer(customerId) {
  try {
    const response = await axios.get(
      `${GHL_API_V2}/contacts/${customerId}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.status === 200 && response.data.contact;
  } catch (error) {
    if (error.response?.status === 404) {
      return false;
    }
    console.error('Error verifying customer:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get all subscriptions for a customer
 */
async function getSubscriptionsByCustomer(customerId) {
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
    
    console.log('Subscriptions API response:', JSON.stringify(response.data, null, 2));
    return response.data.subscriptions || [];
  } catch (error) {
    console.error('Error fetching subscriptions:', error.response?.data || error.message);
    
    // If API endpoint changed or not available, try alternative method
    if (error.response?.status === 404) {
      console.log('Trying alternative subscription lookup method...');
      return await getSubscriptionsAlternative(customerId);
    }
    
    throw error;
  }
}

/**
 * Alternative method to get subscriptions
 */
async function getSubscriptionsAlternative(customerId) {
  try {
    // Try to get subscriptions through orders endpoint
    const response = await axios.get(
      `${GHL_API_V2}/payments/orders`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        },
        params: {
          contactId: customerId,
          locationId: GHL_LOCATION_ID
        }
      }
    );
    
    // Filter for subscription orders
    const orders = response.data.orders || [];
    return orders.filter(order => order.recurring === true);
  } catch (error) {
    console.error('Alternative subscription lookup failed:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Cancel a single subscription
 */
async function cancelSingleSubscription(subscriptionId) {
  try {
    const response = await axios.delete(
      `${GHL_API_V2}/payments/subscriptions/${subscriptionId}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`✓ Successfully canceled subscription ${subscriptionId}`);
    return {
      success: true,
      message: 'Subscription canceled successfully'
    };
  } catch (error) {
    console.error(`✗ Failed to cancel subscription ${subscriptionId}:`, 
      error.response?.data || error.message);
    
    return {
      success: false,
      message: error.response?.data?.message || error.message,
      errorCode: error.response?.status
    };
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    service: 'GHL Subscription Cancellation',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'GoHighLevel Subscription Cancellation Webhook',
    endpoints: {
      health: 'GET /health',
      webhook: 'POST /webhook/cancel-subscription'
    },
    webhookPayload: {
      required: ['customerId'],
      optional: ['subscriptionId'],
      example: {
        customerId: 'contact_id_here',
        subscriptionId: 'optional_subscription_id'
      }
    }
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
  console.log('=====================================');
  console.log('GHL Subscription Cancellation Service');
  console.log('=====================================');
  console.log(`Status: Running`);
  console.log(`Port: ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook/cancel-subscription`);
  console.log(`Health Check: http://localhost:${PORT}/health`);
  console.log('=====================================');
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
