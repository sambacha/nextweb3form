// api coingecko functions

const coingeckoApi = "https://api.coingecko.com/api/v3";

export const getCoinData = async (coin) => {
  return await fetch(`${coingeckoApi}/coins/${coin}`).then((response) =>
    response.json(),
  );
};
