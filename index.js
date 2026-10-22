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
  if(!token){
    return res.status(401).send({message: "Unauthorized access"})
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await getAuth().verifyIdToken(idToken)
    req.decoded_email = decoded.email;
    next()
  } catch (error) {
    return res.status(401).send({message: "unauthorized access"})
  }
}

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-eqifd2k-shard-00-00.tbmejyb.mongodb.net:27017,ac-eqifd2k-shard-00-01.tbmejyb.mongodb.net:27017,ac-eqifd2k-shard-00-02.tbmejyb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bvjx8p-shard-0&authSource=admin&appName=Cluster0`);


export async function connectToMongoDB() {
  try {
    await client.connect();

    const zapDB = client.db("zapDB")
    const serviceCenters = zapDB.collection("serviceCenters")
    const parcelCollection = zapDB.collection("parcelCollection")
    const paymentCollection = zapDB.collection("paymentCollection")
    const userCollection = zapDB.collection("userCollection")
    const riderCollection = zapDB.collection("riderCollection")
    const trackingCollection = zapDB.collection("trackingCollection")

    // -------------- serviceCenter -----------

    const verifyAdmin = async(req, res, next) =>{
      const email = req.decoded_email;
      const query = {email}
      const user = await userCollection.findOne(query)
      if(!user || user?.role !== "admin" ){
        return res.status(403).send({message: "forbidden access"})
      }
      next()
    }


    // parcel tracking log function 

    const parcelLog = async(trackingId, status) =>{
      const logs = {
        trackingId: trackingId,
        status: status,
        details: status,
        createdAt: new Date()
      }
      const result = await trackingCollection.insertOne(logs)
      return result
    }

    app.get('/servicecenter', async(req, res) =>{
        const cursor = serviceCenters.find()
        const result = await cursor.toArray()
        res.send(result)
    })

    app.get("/parcel-logs/:trackingId", async(req, res) =>{
      const trackingId = req.params.trackingId;
      const query = {trackingId}

      const result = await trackingCollection.find(query).toArray()
      res.send(result)
    })

    app.get("/parcel_user_stats/:email", verifyUser, async(req, res) =>{
      const userEmail = req.params.email;
      const query = await parcelCollection.aggregate(
        [
        {
          $match: {senderEmail: userEmail}
        },
       {
         $group: {
          _id: "$senderEmail",
          totalCount: {$sum: 1},
          totalAmount: {$sum: "$costs"},
          totalDelivered: {$sum: {
                 $cond: [{ $eq: ["$deliveryStatus", "delivered"] }, 1, 0]
              }}
        },
        
       }
     
    ]).toArray()
      res.send(query)
    })

    app.get("/parcel_rider_stats/:email", verifyUser, async(req, res) =>{
      const ridersEmail = req.params.email;
      const query = await parcelCollection.aggregate(
        [
        {
          $match: {riderEmail: ridersEmail},
        },
        {
          $group: {
            _id: "ridersEmail",
            totalAssigned: {
              $sum: {
                $cond: [{ $eq: ["$deliveryStatus", "rider_assigned"] }, 1, 0]
              }
            },
            delivered: {$sum: {
                 $cond: [{ $eq: ["$deliveryStatus", "delivered"] }, 1, 0]
              }}
          }
        },
     
    ]).toArray()
      res.send(query)
    })


    app.get("/parcel_admin_state", verifyUser, verifyAdmin, async(req,res) =>{
      const [totalDelivered, newParcel, totalRider, totalUser, totalIncome] = await Promise.all([
        parcelCollection.countDocuments({deliveryStatus: "delivered"}),
        parcelCollection.countDocuments({deliveryStatus: "parcel_paid"}),
        userCollection.countDocuments({role: "rider"}),
        userCollection.countDocuments({role: "user"}),
        parcelCollection.aggregate([
          {
            $match: {deliveryStatus: "delivered"}
          },
          {
            $group: {
              _id: null,
              total: {$sum: "$costs"}
            }
          },
          
        ])
        .toArray()
      ])
      const total = totalIncome[0]?.total ?? 0;
      res.send({totalDelivered, totalRider, totalUser, newParcel, total})
      }
      
    )

    // -------------- riderCollection ------------

    app.get("/riders", verifyUser, verifyAdmin, async(req,res) =>{
      const {status, district, workStatus} = req.query;
      const query = {}
      if(status){
        query.status = status
      }
      if(district){
        query.district = district
      }
      if(workStatus){
        query.workStatus = workStatus
      }
        const cursor = riderCollection.find(query).sort({createdAt: -1})
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
      const workStatus = status === "Accepted" ? "available" : "unavailable"
      const updateDoc = {
        $set : {
          status: status,
          workStatus: workStatus
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

    app.get("/users", verifyUser, verifyAdmin, async(req, res) =>{
       const page = parseInt(req.query.page) || 1;
       const limit = parseInt(req.query.limit) || 5;
       const skip = (page - 1) * limit;
       const total = await userCollection.countDocuments()
       const cursor = userCollection.find().sort({role: 1, _id: 1}).skip(skip).limit(limit)
       const result = await cursor.toArray()
       res.send({result, total, totalPages: Math.ceil(total/limit), currentPage: page})
    })

    app.get("/users/:email/role", async(req, res) =>{
      const email = req.params.email;
      const query = {email}
      const result = await userCollection.findOne(query)
      res.send({role: result?.role || "user"})
    })

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

    app.patch("/users/:email/role", verifyUser, verifyAdmin, async(req, res) =>{
      const {email} = req.params;
      const roleInfo = req.body;
      const query = {email: email}
      const updateDoc = {
        $set: {
          role: roleInfo.role
        }
      }
      const result = await userCollection.updateOne(query, updateDoc)
      res.send(result)
    })


    // ---------------- customerParcelsApi -----------------

    app.get("/myparcels",verifyUser, async(req, res) =>{
       const query = {};
       const {email, deliveryStatus} = req.query

        if(email){
          query.senderEmail = email

          if(email !== req.decoded_email){
            return res.status(403).send({message: "forbidden access"})
          }
        }

        if(deliveryStatus){
          query.deliveryStatus = deliveryStatus
        }
       const page = parseInt(req.query.page) || 1;
       const limit = parseInt(req.query.limit) || 8;
       const skip = (page - 1) * limit;
       const total = await parcelCollection.countDocuments(query)
       const cursor = parcelCollection.find(query).sort({createdAt: -1}).skip(skip).limit(limit)
       const result = await cursor.toArray()
       res.send({result, total, totalPages: Math.ceil(total/limit), currentPage: page})
    })

    app.get("/parcels/admin", verifyUser, verifyAdmin, async(req, res) =>{
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 8;
      const skip = (page - 1) * limit;
      const total = await parcelCollection.countDocuments();
      const cursor = parcelCollection.find().sort({createdAt: -1}).skip(skip).limit(limit)
      const result = await cursor.toArray() 
      res.send({result, total, totalPages: Math.ceil(total/limit), currentPage: page})
    })

    app.get('/parcels/rider', async(req, res) =>{
      const {riderEmail, deliveryStatus} = req.query;
      const query = {}
      if(riderEmail){
        query.riderEmail = riderEmail
      }
      
      if(deliveryStatus !== "delivered"){
        query.deliveryStatus = {$nin: ["delivered"]}
      }
      else {
        query.deliveryStatus = deliveryStatus
      }
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 5;
      const skip = (page - 1) * limit;
      const total = await parcelCollection.countDocuments(query);

      const cursor = parcelCollection.find(query).skip(skip).limit(limit)
      const result = await cursor.toArray()
      res.send({result, total, totalPages: Math.ceil(total/limit), currentPage: page})

    })

    app.get('/parcel/:id', async(req, res) =>{
      const id = req.params.id;
      const query = ({_id: new ObjectId(id)})
      const result = await parcelCollection.findOne(query)
      res.send(result)
    })

    app.post("/sendparcel", async(req, res) =>{
      const query = req.body;
      const trackingId = generateTrackingId()
      query.createdAt = new Date()
      query.trackingId = trackingId

      parcelLog(trackingId, "parcel_created")
      const result = await parcelCollection.insertOne(query)
      res.send(result) 
    })

    app.patch("/parcel/:id", async(req, res) =>{
      const {riderId, riderName, riderEmail, trackingId} = req.body;
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}

      const updateDoc = {
        $set: {
          deliveryStatus: "rider_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail
        }
      }
      const result = await parcelCollection.updateOne(query, updateDoc)

      parcelLog(trackingId, "rider_assigned")
      const riderIdQuery = {_id: new ObjectId(riderId)}
      const riderUpdateDoc = {
        $set: {
          workStatus: "in_transit"
        }
      }
      const riderResult = await riderCollection.updateOne(riderIdQuery, riderUpdateDoc)
      res.send(result,riderResult)

    })

    app.patch("/parcels/:id/status", async(req, res) =>{
      const {deliveryStatus, trackingId} = req.body;
      const query = {_id: new ObjectId(req.params.id)}
      const updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus
        }
      }

      const riderIdQuery = await parcelCollection.findOne(query)

      const result = await parcelCollection.updateOne(query, updateDoc)
      parcelLog(trackingId,deliveryStatus)

      if(deliveryStatus === "delivered"){
        const riderQuery = {_id: new ObjectId(riderIdQuery.riderId)}
        const riderDoc = {
          $set: {
            workStatus: "available"
          }
        }
        
        const riderResult = await riderCollection.updateOne(riderQuery, riderDoc)
        // res.send(riderResult)
      }
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
        parcelName: paymentInfo.parcelName,
        trackingId: paymentInfo.trackingId
      },
      success_url: `${process.env.DOMAIN_API}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN_API}/dashboard/payment-cancel`,
  });
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

      const trackingId= session.metadata.trackingId

      const updateDoc = {
        $set: {
          paymentStatus: "paid",
          deliveryStatus: 'parcel_paid',
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
        parcelLog(trackingId, "parcel_paid")

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

  app.get("/all_payments", verifyUser, verifyAdmin, async(req,res) =>{
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8;
    const skip = (page - 1) * limit;
    const total = await paymentCollection.countDocuments();
    const result = await paymentCollection.find().sort({paidAt: 1}).skip(skip).limit(limit).toArray()
    res.send({result, total, totalPages: Math.ceil(total/limit), currentPage: page})
  })


    return client;
  } catch (err) {
    console.dir(err);
  }
}
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