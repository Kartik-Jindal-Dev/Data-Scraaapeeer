FROM mcr.microsoft.com/playwright:v1.45.1-jammy

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]