require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");

const app = express();
const { SHOPIFY_STORE, SHOPIFY_API_TOKEN, PORT } = process.env;

app.use(bodyParser.json());
app.use(cors());

const shopify = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/2024-01`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_API_TOKEN,
    "Content-Type": "application/json"
  }
});

// --------------------- Booking Utilities ---------------------
function isOverlapping(newB, existing) {
  return existing.some(b =>
    new Date(newB.start) < new Date(b.end) &&
    new Date(b.start) < new Date(newB.end)
  );
}

async function getBookings(productId) {
  try {
    const res = await shopify.get(`/products/${productId}/metafields.json`);
    const field = res.data.metafields.find(
      f => f.namespace === "custom" && f.key === "booking"
    );
    const bookings = field ? JSON.parse(field.value || "[]") : [];
    return { metafield: field || null, bookings };
  } catch (err) {
    console.error("Error fetching bookings:", err);
    return { metafield: null, bookings: [] };
  }
}

async function saveBookings(productId, metafield, bookings) {
  if (metafield) {
    await shopify.put(`/metafields/${metafield.id}.json`, {
      metafield: { value: JSON.stringify(bookings), type: "json" }
    });
  } else {
    await shopify.post(`/products/${productId}/metafields.json`, {
      metafield: {
        namespace: "custom",
        key: "booking",
        type: "json",
        value: JSON.stringify(bookings)
      }
    });
  }
}

// --------------------- Endpoints ---------------------

// Get existing bookings
app.get("/availability", async (req, res) => {
  try {
    const productId = req.query.product_id;
    if (!productId) return res.json({ bookings: [] });

    const { bookings } = await getBookings(productId);
    res.json({ bookings });
  } catch (err) {
    console.error(err);
    res.json({ bookings: [] });
  }
});

// Validate a booking
app.post("/validate-booking", async (req, res) => {
  try {
    const { productId, checkin, checkout } = req.body;
    if (!productId || !checkin || !checkout) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { bookings } = await getBookings(productId);
    const newBooking = {
      start: new Date(checkin).toISOString(),
      end: new Date(checkout).toISOString()
    };

    if (isOverlapping(newBooking, bookings)) {
      return res.status(400).json({ error: "Selected dates are already booked." });
    }

    res.json({ available: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while validating booking." });
  }
});

app.post("/create-draft-order", async (req, res) => {
  try {
    const { productId, checkin, checkout, guests, email } = req.body;

    // ✅ Validate required fields
    if (!productId || !checkin || !checkout || !guests || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 1️⃣ Fetch product to get base price & variant ID
    const productRes = await shopify.get(`/products/${productId}.json`);
    const variant = productRes.data.product.variants[0];
    const basePrice = Number(variant.price); // Shopify product price (per night per guest)
    const variantId = variant.id;

    // 2️⃣ Calculate nights
    const nights = Math.ceil(
      (new Date(checkout) - new Date(checkin)) / (1000 * 60 * 60 * 24)
    );
    
    // 3️⃣ Calculate total price dynamically
    const totalPrice = basePrice * nights * guests;

    // 4️⃣ Draft order payload
    const draftOrderPayload = {
      draft_order: {
        line_items: [
          {
            variant_id: variantId,
            quantity: 1,
            custom_price: Number(totalPrice.toFixed(2)),
            properties: [
              { name: "Check In", value: checkin },
              { name: "Check Out", value: checkout },
              { name: "Guests", value: guests },
              { name: "Nights", value: nights }
            ]
          }
        ],
        customer: { email },
        use_customer_default_address: true,
        send_invoice: true,
        tax_exempt: true
      }
    };

    // 5️⃣ Create draft order
    const response = await shopify.post("/draft_orders.json", draftOrderPayload);
    const draftOrder = response.data.draft_order;

    console.log("FINAL DRAFT ORDER:", draftOrder);

    res.json({ invoiceUrl: draftOrder.invoice_url });

  } catch (err) {
    console.error("Error in /create-draft-order:", err.response?.data || err);
    res.status(500).json({ error: "Error creating draft order" });
  }
});


// ---------------- Webhook: save bookings ----------------
app.post("/webhooks/orders-create", async (req, res) => {
  try {
    const order = req.body;
    if (!order?.line_items) return res.status(400).send("No line_items found");

    for (const item of order.line_items) {
      const checkIn = item.properties?.find(p => p.name === "Check In")?.value;
      const checkOut = item.properties?.find(p => p.name === "Check Out")?.value;
      if (!checkIn || !checkOut || !item.product_id) continue;

      const booking = {
        start: new Date(checkIn).toISOString(),
        end: new Date(checkOut).toISOString()
      };

      const { metafield, bookings } = await getBookings(item.product_id);
      if (isOverlapping(booking, bookings)) continue;

      bookings.push(booking);
      await saveBookings(item.product_id, metafield, bookings);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT || 3000, () => {
  console.log("🚀 Booking server running");
});
