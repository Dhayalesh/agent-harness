import mongoose from "mongoose";
import { ModelProvider } from "./src/models/model-provider.js";

await mongoose.connect(process.env.MONGODB_URI, {
  dbName: process.env.MONGODB_DB_NAME,
});

const docs = await ModelProvider.find({}).lean();
console.log(`Total model providers: ${docs.length}`);
for (const doc of docs) {
  console.log({
    name: doc.name,
    provider: doc.provider,
    model: doc.model,
    baseURL: doc.baseURL,
    enabled: doc.enabled,
    isDefault: doc.isDefault,
    hasPricing: Boolean(doc.pricing),
    pricingModel: doc.pricing?.model,
  });
}

await mongoose.disconnect();
