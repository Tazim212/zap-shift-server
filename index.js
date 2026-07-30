import express from "express"
const app = express()
import {MongoClient, ObjectId} from'mongodb';
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import Stripe from "stripe";
const stripe = new Stripe(process.env.PAYMENT_KEY);
const port = process.env.PORT || 3000;
import crypto from "crypto";

import { initializeApp, cert } from "firebase-admin/app";
import { readFileSync } from "fs";
import { getAuth } from "firebase-admin/auth";

const serviceAccount = JSON.parse(
  readFileSync(new URL("./zap-shift-app-firebase-adminsdk.json", import.meta.url))
);

initializeApp({
  credential: cert(serviceAccount),
});


function generateTrackingId() {
    const date = new Date().toISOString().slice(0,10).replace(/-/g, "");
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();

    return `SD-${date}-${random}`;
}


app.use(cors())
app.use(express.json())
app.use(express.static('public'));

const verifyUser = async(req, res, next) =>{
  const token = req.headers.authorization
  // console.log(token)
  if(!token){
    return res.status(401).send({message: "Unauthorized access"})
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await getAuth().verifyIdToken(idToken)
    req.decoded_email = decoded.email;
    next()
    // console.log(decoded)
  } catch (error) {
    return res.status(401).send({message: "unauthorized access"})
  }
}

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-eqifd2k-shard-00-00.tbmejyb.mongodb.net:27017,ac-eqifd2k-shard-00-01.tbmejyb.mongodb.net:27017,ac-eqifd2k-shard-00-02.tbmejyb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bvjx8p-shard-0&authSource=admin&appName=Cluster0`);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");

    const zapDB = client.db("zapDB")
    const serviceCenters = zapDB.collection("serviceCenters")
    const parcelCollection = zapDB.collection("parcelCollection")
    const paymentCollection = zapDB.collection("paymentCollection")
    const userCollection = zapDB.collection("userCollection")
    const riderCollection = zapDB.collection("riderCollection")


    // -------------- serviceCenter -----------

    app.get('/servicecenter', async(req, res) =>{
        const cursor = serviceCenters.find()
        const result = await cursor.toArray()
        res.send(result)
    })

    // -------------- riderCollection ------------

    app.get("/riders", async(req,res) =>{
        const cursor = riderCollection.find()
        const result = await cursor.toArray()
        res.send(result)
    })

    app.post("/riders", async(req, res) =>{
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date()
      const result = await riderCollection.insertOne(rider)
      res.send(result)
    })

    app.patch("/riders/:id", async(req, res) =>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const status = req.query.status;
      const updateDoc = {
        $set : {
          status: status
        }
      }
      const result = await riderCollection.updateOne(query, updateDoc)
      res.send(result)
    })

    app.delete("/riders/:id", async(req, res) =>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await riderCollection.deleteOne(query)
      res.send(result)
    })


    // ------------- userCollection --------------

    app.post("/users", async(req, res) =>{
      const users = req.body;
      users.role = "user";
      users.createdAt = new Date()
      const email = users.email;
      const existingUser = await userCollection.findOne({email})
      if(existingUser){
        return res.send({message: "user already exist"})
      }

      const result = await userCollection.insertOne(users)
      res.send(result)
    })

    // ---------------- customerParcelsApi -----------------

    app.get("/myparcels", verifyUser, async(req, res) =>{
       const query = {};
        const {email} = req.query

        if(email){
          query.senderEmail = email

          if(email !== req.decoded_email){
            return res.status(403).send({message: "forbidden access"})
          }
        }
        const cursor = parcelCollection.find(query).sort({createdAt: -1})
        const result = await cursor.toArray()
        res.send(result)
    })

    app.get('/parcel/:id', async(req, res) =>{
      const id = req.params.id;
      const query = ({_id: new ObjectId(id)})
      const result = await parcelCollection.findOne(query)
      res.send(result)
    })

    app.post("/sendparcel", async(req, res) =>{
      const query = req.body;
      query.createdAt = new Date()
      const result = await parcelCollection.insertOne(query)
      res.send(result) 
    })

    app.delete("/myparcels/:id", async(req, res) =>{
      const parcelId = req.params.id;
      const query = {_id: new ObjectId(parcelId)};
      const result = await parcelCollection.deleteOne(query)
      res.send(result)
    })
    
    // ------------- Payment APi ------------

    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      const amounts = parseInt(paymentInfo.costs) * 100;

     const session = await stripe.checkout.sessions.create({
      line_items: [
        {
        price_data: {
          currency: 'USD',
          unit_amount: amounts,
          product_data: {
            name: paymentInfo.parcelName
          }
        },
        quantity: 1,
        },
      ],
      customer_email: paymentInfo.senderEmail,
      mode: 'payment',
      metadata: {
        parcelId: paymentInfo.parcelId,
        parcelName: paymentInfo.parcelName
      },
      success_url: `${process.env.DOMAIN_API}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN_API}/dashboard/payment-cancel`,
  });

      // console.log(session)
      res.send({url: session.url})
});

  app.patch("/payment-success", async(req, res) =>{
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId)

    const transactionId = session.payment_intent;

    const query = {transactionId: transactionId}
    const paymentExist = await paymentCollection.findOne(query)

    if(paymentExist){
      return res.send({
        message: "payment already exists", 
        transactionId: transactionId,
        trackingId: paymentExist.trackingId
      })
    }


    if(session.payment_status === "paid"){
      const id = session.metadata.parcelId;
      const query = ({_id: new ObjectId(id)})

      const trackingId= generateTrackingId()

      const updateDoc = {
        $set: {
          paymentStatus: "paid",
          trackingId: trackingId
        }
      }
      const result = await parcelCollection.updateOne(query, updateDoc)

      const paymentInfo = {
        parcelId: session.metadata.parcelId,
        parcelName: session.metadata.parcelName,
        customerEmail: session.customer_email,
        amount: session.amount_total/100,
        currency: session.currency,
        transactionId: session.payment_intent,
        paymentStatus: session.payment_status,
        trackingId: trackingId,
        paidAt: new Date(),
      }

      if(session.payment_status === "paid"){
      try {
        const reesultPayment = await paymentCollection.insertOne(paymentInfo)
        res.send({success: true, 
        modifyParcel: result, 
        transactionId: session.payment_intent,
        trackingId: trackingId,
        paymentInfo: reesultPayment
      })
      } catch (error) {
        console.log(error)
      }
      }

    }
    // console.log(session)
  })

  app.get("/payments", verifyUser, async(req, res) =>{
    const email = req.query.email;
    const query = {}

    if(email){
      query.customerEmail = email
    }
    const result = await paymentCollection.find(query).toArray()
    res.send(result)
  })




    return client;
  } catch (err) {
    console.dir(err);
  }
}
// Call this only when your application terminates
export async function disconnectFromMongoDB() {
//   await client.close();
}

connectToMongoDB()

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})