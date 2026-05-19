FROM mcr.microsoft.com/playwright:v1.45.1-jammy

RUN apt-get update && apt-get install -y build-essential python3

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]