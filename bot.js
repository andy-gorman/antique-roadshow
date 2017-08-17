'use strict';

var graph = require('fbgraph')
		, request = require('request')
		, fs = require('fs')
		, Twitter = require('twitter')
		, Swagger = require('swagger-client')
		, MongoClient = require('mongodb').MongoClient
		;

require('dotenv').config();

var CLIENT = new Twitter({
	consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

const PAGE_ID = '31232272780';
const COLLECTION_NAME = 'fb_posts';

Array.prototype.pick = function() {
	return this[Math.floor(Math.random() * this.length)];
}

Array.prototype.contains = function(element) {
	return this.indexOf(element) > -1;
}

graph.setVersion('2.10');

// More or less the entry point. What runs every 5 hours.
function run() {
	// The facebook stuff
	graph.get(PAGE_ID + '/feed?fields=message,from,full_picture,date,created_time&limit=100&access_token=' + process.env.FACEBOOK_ACCESS_TOKEN, function(err, res) {
		if (err) {
			return console.log('Error making a facebook graph request: ', err);
		}

		var fb_posts = res.data.filter(filter_bad_posts);
		var transformed_posts = transform_data(fb_posts);
		MongoClient.connect(process.env.MONGO_DB_CONNECTION_STRING).then(db => {
			return insert_post_and_return_oldest(db, transformed_posts);
		}).then((results) => {
			if (results.length > 0) {
				var post = results[0];
				send_tweet(post);
			}
		}).catch(err => {
			console.log(err.stack);
		});
	});
}

function insert_post_and_return_oldest(db, transformed_posts) {
	return db.collection(COLLECTION_NAME).find({_id: {$in: transformed_posts.map(post =>  post._id)}}).toArray()
		.then (existing_posts => {
			var existing_ids = new Set(existing_posts.map(post => post._id));
			var posts_to_enter = transformed_posts.filter(post => !existing_ids.has(post._id));
			if (posts_to_enter.length > 0) {
				return db.collection(COLLECTION_NAME).insertMany(posts_to_enter).then((results) => {
					return select_oldest(db);
				});
			}
			return select_oldest(db);
		});
}

function select_oldest(db) {
	return db.collection(COLLECTION_NAME).find({been_posted: false}).sort({'created_time': 1}).limit(1).toArray().then(post => {
		db.close();
		return post;
	});
}

/**
  * Filter out posts that either don't have a picture attached,
  * were posted by the Antiques Roadshow Facebook page,
  * or is an image this account has already tweeted
  */
function filter_bad_posts(post) {
	// Filter out posts without a full picture
	if (!post.hasOwnProperty('full_picture')) {
		return false;
	}
  
  //Filter posts made by the page itself
  if (post.hasOwnProperty('from') && post.from.hasOwnProperty('id')
			&& post.from.id === PAGE_ID) {
  	return false;
  }
  return true;
}

function transform_data(posts) {
	var transformed_posts = [];
	posts.forEach(post =>
	{
		var msg = '' + (post.message || '');
		if (msg.length > 140) {
			msg = msg.substr(0, 137) + '...';
		}
		transformed_posts.push({_id: post.id, text: msg, image_url: post.full_picture, created_time: post.created_time, been_posted: false});
	});
	return transformed_posts;
}



function send_tweet(post) {
	request.get(post.image_url)
		.on('response', (response) => {
		 	CLIENT.post('media/upload', {media: response}, function(error, media, response) {
			  if (!error) {
			    // Lets tweet it
			    var status = {
			      status: post.text,
			      media_ids: media.media_id_string // Pass the media id string
			    }

			    CLIENT.post('statuses/update', status, function(error, tweet, response) {
			      if (!error) {
			        console.log(tweet);
	        		MongoClient.connect(process.env.MONGO_DB_CONNECTION_STRING).then((db) => {
			        	return update_post(post, db);
				      });
			      }
			    });
		 	 	}
		 	 	else {
		 	 		console.log(error);
		 	 	}
			});
  	});
}

function update_post(post, db) {
	console.log(post._id);
	return db.collection(COLLECTION_NAME).updateOne({_id: post._id}, {$set: {been_posted: true}}).then((res) => {
		db.close();
		console.log('closed');
	});
}

run();
setInterval(run, 1000 * 60 * 60 * 8);