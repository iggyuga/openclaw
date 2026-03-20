import { config } from "./config.js";
import { log } from "./logger.js";

export interface FearGreedData {
  value: number; // 0–100
  classification: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: number;
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  sentiment: "positive" | "negative" | "neutral";
  publishedAt: string;
}

export interface SentimentSnapshot {
  fearGreed: FearGreedData;
  news: NewsItem[];
  // Composite score: -1 (very bearish) to +1 (very bullish)
  score: number;
}

// Fear & Greed Index — free, no API key needed
export async function fetchFearGreed(): Promise<FearGreedData> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const json = (await res.json()) as {
      data: Array<{ value: string; value_classification: string; timestamp: string }>;
    };
    const item = json.data[0];
    return {
      value: parseInt(item.value, 10),
      classification: item.value_classification,
      timestamp: parseInt(item.timestamp, 10) * 1000,
    };
  } catch (err) {
    log.warn("Failed to fetch Fear & Greed index", err);
    return { value: 50, classification: "Neutral", timestamp: Date.now() };
  }
}

// CryptoPanic news with sentiment — requires free API key
export async function fetchCryptoPanicNews(currencies = ["ETH", "BTC"]): Promise<NewsItem[]> {
  if (!config.cryptopanic.apiKey) {
    log.debug("No CryptoPanic API key set, skipping news fetch");
    return [];
  }

  try {
    const params = new URLSearchParams({
      auth_token: config.cryptopanic.apiKey,
      currencies: currencies.join(","),
      filter: "hot",
      public: "true",
    });

    const res = await fetch(`https://cryptopanic.com/api/developer/v2/posts/?${params}`);
    const json = (await res.json()) as {
      results: Array<{
        title: string;
        url: string | null;
        original_url: string | null;
        source: { title: string } | null;
        votes: { positive: number; negative: number; important: number } | null;
        published_at: string;
        panic_score: number | null; // v2: 0=bullish, 100=panic/bearish
      }>;
    };

    return json.results.slice(0, 20).map((item) => {
      let sentiment: NewsItem["sentiment"] = "neutral";

      if (item.panic_score != null) {
        // panic_score: low = bullish, high = panic/bearish
        if (item.panic_score < 35) sentiment = "positive";
        else if (item.panic_score > 65) sentiment = "negative";
      } else if (item.votes) {
        // fallback to vote ratio
        const { positive, negative } = item.votes;
        if (positive > negative * 1.5) sentiment = "positive";
        else if (negative > positive * 1.5) sentiment = "negative";
      }

      return {
        title: item.title,
        url: item.url ?? item.original_url ?? "#",
        source: item.source?.title ?? "Unknown",
        sentiment,
        publishedAt: item.published_at,
      };
    });
  } catch (err) {
    log.warn("Failed to fetch CryptoPanic news", err);
    return [];
  }
}

// Combine Fear & Greed + news into a single -1..+1 sentiment score
export async function fetchSentiment(): Promise<SentimentSnapshot> {
  const [fearGreed, news] = await Promise.all([fetchFearGreed(), fetchCryptoPanicNews()]);

  // Fear & Greed: 0–100 → -1..+1
  const fgScore = (fearGreed.value - 50) / 50;

  // News: count positive vs negative
  const posNews = news.filter((n) => n.sentiment === "positive").length;
  const negNews = news.filter((n) => n.sentiment === "negative").length;
  const totalNews = posNews + negNews;
  const newsScore = totalNews > 0 ? (posNews - negNews) / totalNews : 0;

  // Weighted average: Fear & Greed is more reliable
  const score = fgScore * 0.7 + newsScore * 0.3;

  log.info(
    `Sentiment: F&G=${fearGreed.value} (${fearGreed.classification}), news=${newsScore.toFixed(2)}, composite=${score.toFixed(2)}`,
  );

  return { fearGreed, news, score };
}
