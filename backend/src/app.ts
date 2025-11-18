import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { json, urlencoded } from 'express';
import { router as moduleRouter } from './modules';
import { notFoundHandler, errorHandler } from './middleware';

const app = express();


app.use(helmet());
app.use(cors());
app.use(json());
app.use(urlencoded({ extended: true }));
app.use(morgan('dev'));

app.use('/api', moduleRouter);


app.get('/health', (_, res) => res.json({ status: 'OK', service: 'backend' }));

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
