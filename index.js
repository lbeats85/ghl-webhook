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
 * Cancel subscription in Stripe AND return days remaining for access revocation
 * This does BOTH: cancels the subscription + tells you how long to keep access
 */
app.post('/webhook/cancel-subscription', async (req, res) => {
  try {
    console.log('=== New Webhook Request ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    const { customerId, cancelInStripe = false } = req.body;
    
    // Validate input
    if (!customerId) {
      console.error('Missing customerId in request');
      return res.status(400).json({ 
        success: false, 
        error: 'customerId is required in the request body' 
      });
    }

    console.log(`Cancel in Stripe: ${cancelInStripe ? 'YES' : 'NO (calculate only)'}`);


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

    // Get Stripe Customer ID from custom fields
    // Look for a value that starts with 'cus_' (Stripe customer ID pattern)
    let stripeCustomerId = null;
    
    if (contact.customFields && Array.isArray(contact.customFields)) {
      const customerIdField = contact.customFields.find(field => 
        field.value && typeof field.value === 'string' && field.value.startsWith('cus_')
      );
      stripeCustomerId = customerIdField?.value;
    }

    if (!stripeCustomerId) {
      console.error('Stripe Customer ID not found in contact custom fields');
      console.log('Available custom fields:', JSON.stringify(contact.customFields, null, 2));
      return res.status(404).json({ 
        success: false, 
        error: 'Stripe Customer ID not found in GoHighLevel contact. Please ensure a custom field contains a Stripe Customer ID (starts with cus_).' 
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

    // Step 3: BEFORE canceling, calculate days remaining for access
    const now = Math.floor(Date.now() / 1000);
    let accessDaysRemaining = 0;
    let accessEndDate = null;
    
    // Find the active subscription with the furthest end date
    for (const sub of subscriptions) {
      const isActive = 
        sub.status === 'active' || 
        sub.status === 'trialing' || 
        sub.status === 'past_due' || 
        sub.status === 'unpaid' ||
        sub.status === 'incomplete';
      
      if (isActive && sub.current_period_end) {
        const daysLeft = Math.ceil((sub.current_period_end - now) / (60 * 60 * 24));
        if (daysLeft > accessDaysRemaining) {
          accessDaysRemaining = daysLeft;
          accessEndDate = new Date(sub.current_period_end * 1000).toISOString();
        }
      }
    }

    console.log('=== Access Period Calculation ===');
    console.log(`Days of access remaining: ${accessDaysRemaining}`);
    console.log(`Access should end on: ${accessEndDate || 'N/A'}`);

    // Step 4: Optionally cancel subscriptions in Stripe (if requested)
    const results = [];
    
    if (cancelInStripe) {
      console.log('=== Canceling Subscriptions in Stripe ===');
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
    } else {
      console.log('=== Skipping Stripe Cancellation (calculate only mode) ===');
    }

    // Step 5: Return results including access information
    const allSuccessful = results.length === 0 || results.every(r => r.success);
    console.log('=== Processing Complete ===');
    console.log(`Stripe Cancellation: ${cancelInStripe ? 'Performed' : 'Skipped'}`);
    if (cancelInStripe) {
      console.log(`Canceled: ${results.filter(r => r.success).length}/${results.length}`);
    }
    console.log(`Customer should keep access for: ${accessDaysRemaining} days`);

    return res.status(allSuccessful ? 200 : 207).json({
      success: allSuccessful,
      message: cancelInStripe ? 
        (allSuccessful ? 'Subscriptions canceled and access period calculated' : 'Some operations failed') :
        'Access period calculated (Stripe cancellation skipped)',
      mode: cancelInStripe ? 'cancel-and-calculate' : 'calculate-only',
      customerId: customerId,
      stripeCustomerId: stripeCustomerId,
      totalSubscriptions: subscriptions.length,
      canceledCount: cancelInStripe ? results.filter(r => r.success).length : 0,
      stripeCancellation: cancelInStripe ? results : 'skipped',
      // Access information for GoHighLevel automation
      accessDaysRemaining: Math.max(0, accessDaysRemaining),
      accessEndDate: accessEndDate,
      revokeAccessIn: Math.max(0, accessDaysRemaining),
      nextStep: {
        action: 'Wait then revoke access',
        waitDays: Math.max(0, accessDaysRemaining),
        description: `Keep customer access active for ${accessDaysRemaining} days, then trigger access revocation automation`
      }
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
    version: '3.0.0',
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
    version: '3.0.0',
    endpoints: {
      health: 'GET /health',
      cancelSubscription: 'POST /webhook/cancel-subscription'
    },
    webhookPayload: {
      required: ['customerId'],
      optional: ['cancelInStripe'],
      examples: {
        calculateOnly: {
          customerId: 'contact_id_from_ghl',
          cancelInStripe: false
        },
        cancelAndCalculate: {
          customerId: 'contact_id_from_ghl',
          cancelInStripe: true
        }
      }
    },
    modes: {
      calculateOnly: {
        description: 'Just calculate access days remaining (if you handle Stripe cancellation elsewhere)',
        payload: { customerId: 'abc123', cancelInStripe: false },
        use: 'When you already have Stripe cancellation set up separately'
      },
      cancelAndCalculate: {
        description: 'Cancel in Stripe AND calculate access days',
        payload: { customerId: 'abc123', cancelInStripe: true },
        use: 'When you want this webhook to handle everything'
      }
    },
    workflow: [
      '1. Customer clicks cancel button',
      '2. (Optional) Your existing system cancels Stripe subscription',
      '3. GoHighLevel calls this webhook with contact ID',
      '4. Webhook fetches subscription from Stripe',
      '5. Webhook calculates days remaining in billing period',
      '6. (Optional) Webhook can also cancel in Stripe if cancelInStripe=true',
      '7. Webhook returns: days of access remaining',
      '8. GoHighLevel waits X days (customer keeps access)',
      '9. After X days: GoHighLevel triggers "revoke access" automation',
      '10. Automation removes tags, access, permissions, etc.'
    ],
    exampleResponse: {
      success: true,
      message: 'Access period calculated (Stripe cancellation skipped)',
      mode: 'calculate-only',
      canceledCount: 0,
      stripeCancellation: 'skipped',
      accessDaysRemaining: 25,
      accessEndDate: '2026-02-25T00:00:00.000Z',
      revokeAccessIn: 25,
      nextStep: {
        action: 'Wait then revoke access',
        waitDays: 25,
        description: 'Keep customer access for 25 days, then revoke'
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
