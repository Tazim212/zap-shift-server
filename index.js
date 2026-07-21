import express from "express"
const app = express()
import {MongoClient, ObjectId} from'mongodb';
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import Stripe from "stripe";
const stripe = new Stripe(process.env.PAYMENT_KEY);
const port = process.env.PORT || 3000;


app.use(cors())
app.use(express.json())
app.use(express.static('public'));

const YOUR_DOMAIN = `${process.env.DOMAIN_API}`;


const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-eqifd2k-shard-00-00.tbmejyb.mongodb.net:27017,ac-eqifd2k-shard-00-01.tbmejyb.mongodb.net:27017,ac-eqifd2k-shard-00-02.tbmejyb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bvjx8p-shard-0&authSource=admin&appName=Cluster0`);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");

    const zapDB = client.db("zapDB")
    const serviceCenters = zapDB.collection("serviceCenters")
    const parcelCollection = zapDB.collection("parcelCollection")


    // -------------- serviceCenter -----------

    app.get('/servicecenter', async(req, res) =>{
        const cursor = serviceCenters.find()
        const result = await cursor.toArray()
        res.send(result)
    })

    // ---------------- customerParcelsApi -----------------

    app.get("/myparcels", async(req, res) =>{
       const query = {};
        const {email} = req.query

        if(email){
          query.senderEmail = email
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
      success_url: `${process.env.DOMAIN_API}/dashboard/payment-success`,
      cancel_url: `${process.env.DOMAIN_API}/dashboard/payment-cancel`,
  });

      console.log(session)
      res.send({url: session.url})
  // res.redirect(303, session.url);
});








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