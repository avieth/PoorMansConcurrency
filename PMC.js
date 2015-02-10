/**
 *
 * Deterministic, cooperative concurrency for a single-threaded world.
 * Based on the Functional Pearl by Koen Claessen entitled
 *
 *   A Poor Man's Concurrency Monad
 *
 * but slightly modified for JavaScript: no monad transformer, no monad
 * parameter for Action.
 *
 */

/**
 * Type to represent functions in continuation passing style.
 *
 *   type C a = (a -> Action) -> Action
 *
 * i.e. functions which, given another function mapping values of some type
 * to Action, will themselves produce an Action.
 *
 * You can think of values in this type as functions which produce something
 * of type a. The continuation is there to make them composable.
 *
 * @param {function} in_routine - must accept a single argument: a continuation.
 *   Must return an Action.
 *
 * @constructor
 */
var C = function (in_routine) {
  /**
   * @type {function}
   */
  this.routine = in_routine;
};

/**
 * Run a C, producing an Action, according to the input continuation.
 *
 * @param {function} in_continuation - if this C has type t, then this
 *   continuation must have type t -> Action.
 */
C.prototype.runC = function (in_continuation) {
  return this.routine(in_continuation);
};

/**
 * Monadic return. Make a C which runs its continuation with a constant value.
 *
 * @param {t} in_thing
 *
 * @return {C.<t>}
 */
C.return = function (in_thing) {
  return new C(function (in_continuation) {
    return in_continuation(in_thing);
  });
};

/**
 * Monadic bind. Run this C, use its value through in_k to get another C,
 * and then run that with the top-level continuation.
 *
 * @param {function} in_k - if this C has type parameter t, then in_k must
 *   expect a t and produce a C.<s>.
 *
 * @returns {C.<s>}
 */
C.prototype.andThen = function (in_k) {
  var that = this;
  return new C(function (in_continuation) {
    return that.runC(function (in_thing) {
      return in_k(in_thing).runC(in_continuation);
    });
  });
};

/**
 * Like andThen, but the next C does not depend upon the value of this
 * C.
 *
 * @param {C.<s>}
 *
 * @returns {C.<s>}
 */
C.prototype.then = function (in_next) {
  return this.andThen(function () {
    return in_next;
  });
};

var Action = function () {};
Action.prototype.isAtom = function () { return false; };
Action.prototype.isFork = function () { return false; };
Action.prototype.isStop = function () { return false; };

var Atom = function (in_routine) {
  /**
   * @type {function} must return an Action in all paths (no continuation).
   */
  this.routine = in_routine;
};
Atom.prototye = Object.create(Action.prototype);

Atom.prototype.isAtom = function () { return true; };

Atom.prototype.runAtom = function () {
  return this.routine();
};

var Fork = function (in_routine1, in_routine2) {
  /**
   * @type {function} must return an Action in all paths (no continuation).
   */
  this.routine1 = in_routine1;
  /**
   * @type {function} must return an Action in all paths (no continuation).
   */
  this.routine2 = in_routine2;
};
Fork.prototype = Object.create(Action.prototype);

Fork.prototype.isFork = function () { return true; };

/**
 * Terminal action.
 */
var Stop = function () {};
Stop.prototype = Object.create(Action.prototype);

Stop.prototype.isStop = function () { return true; };

var Queue = function (in_array) {
  this._queue = in_array;
};

Queue.singleton = function (in_thing) {
  return new Queue([in_thing]);
};

Queue.prototype.enqueue = function (in_thing) {
  // SLOOOOW must redefined queue for constant-time enqueue and dequeue.
  this._queue.unshift(in_thing);
};

Queue.prototype.dequeue = function () {
  return this._queue.pop();
};

Queue.prototype.isEmpty = function () {
  return this._queue.length === 0;
};


/**
 * Top-level class for a sum type of things which give meaning to
 * Actions.
 *
 * @constructor
 * @abstract
 */
var Concurrency = function () {};

/**
 * Run actions in a round-robin fashion.
 *
 * @constructor
 */
var RoundRobin = function (in_queue) {
  this.queue = in_queue;
};
RoundRobin.prototype = Object.create(Concurrency.prototype);

RoundRobin.singleAction = function (in_action) {
  return new RoundRobin(Queue.singleton(in_action));
};

/**
 * Run poor man's concurrency, subject to a custom strategy as expressed
 * by the first argument in_runner.
 */
RoundRobin.prototype.runF = function (in_runner, in_continuation) {
  if (this.queue.isEmpty()) {
    in_continuation({});
  } else {
    var next = this.queue.dequeue();
    if (next.isAtom()) {
      var action = next.runAtom();
      this.queue.enqueue(action);
    } else if (next.isFork()) {
      this.queue.enqueue(next.routine1);
      this.queue.enqueue(next.routine2);
    } else if (next.isStop()) {
      // Nothing to do here.
    } else {
      console.error('RoundRobin.run : unknown action encountered!', next);
    }
    var that = this;
    in_runner(function () {
      that.runF(in_runner, in_continuation);
    });
  }
};

/**
 * Like runF, except that we profile the time elapsed to complete the
 * execution of this RoundRobin.
 */
RoundRobin.prototype.runFInitial = function (in_runner, in_continuation) {
  in_continuation = in_continuation || function () {
    console.debug('RoundRobin.runF : completed!');
  };
  var start = window.performance.now();
  return this.runF(in_runner, function (in_value) {
    var delta = window.performance.now() - start;
    console.debug('RoundRobin.runF time elapsed', delta);
    return in_continuation(in_value);
  });
};

/**
 * Run the action synchronously, without ever yielding to the browser.
 */
RoundRobin.prototype.runSync = function (in_continuation) {
  return this.runFInitial(
    function (in_continuation) {
      return in_continuation();
    },
    in_continuation
  );
};

/**
 * Run with yielding via setTimeout(_, 0).
 */
RoundRobin.prototype.runAsync = function (in_continuation) {
  return this.runFInitial(
    function (in_continuation) {
      setTimeout(in_continuation, 0);
    },
    in_continuation
  );
};

/**
 * A strategy in which the queue is cleared in synchronous batches of a
 * fixed size.
 */
RoundRobin.prototype.runBatchAsync = function (in_batchSize, in_continuation) {
  var counter = 0;
  return this.runFInitial(
    function (in_continuation) {
      counter += 1;
      if (counter === in_batchSize) {
        counter = 0;
        setTimeout(in_continuation, 0);
      } else {
        in_continuation();
      }
    },
    in_continuation
  );
};

/**
 * A strategy in which the queue is cleared synchronously until it has taken
 * more than some time duration (in ms).
 */
RoundRobin.prototype.runTimedAsync = function (in_timeBound, in_continuation) {
  var baseTime = window.performance.now();
  var delta;
  return this.runFInitial(
    function (in_continuation) {
      delta = window.performance.now() - baseTime;
      if (delta > in_timeBound) {
        setTimeout(in_continuation, 0);
        baseTime = window.performance.now();
      } else {
        in_continuation();
      }
    },
    in_continuation
  );
};

/**
 * Run with yielding via requestAnimationFrame(_).
 */
RoundRobin.prototype.runAnimation = function (in_continuation) {
  return this.runFInitial(
    function (in_continuation) {
      requestAnimationFrame(in_continuation);
    },
    in_continuation
  );
};

/**
 * Turn a C into an Action; an Atom which runs the input C and then stops.
 */
action = function (in_c) {
  return new Atom(function () {
    return in_c.runC(function () { 
      return new Stop();
    });
  });
};

/**
 * Produce a C from an arbitrary synchronous routine.
 */
atom = function (in_routine) {
  return new C(function (in_continuation) {
    return new Atom(function () {
      return in_continuation(in_routine());
    });
  });
};

/**
 * Create a C which does nothing, but ignores its continuation and stops.
 */
stop = function () {
  return new C(function (in_continuation) {
    return new Stop();
  });
};

/**
 * Careful, the return C instance has type C (), i.e. is expects the unit
 * type to be fed to its continuation.
 */
fork = function (in_c) {
  return new C(function (in_continuation) {
    return new Fork(
      action(in_c),
      in_continuation({})
    )
  });
};

parallel = function (in_c1, in_c2) {
  return new C(function (in_continuation) {
    return new Fork(
      // We force both C's here. Is this OK?
      // The results of in_c1, in_c2 will be run in parallel, but they
      // themselves will be run in series.
      in_c1.runC(in_continuation),
      in_c2.runC(in_continuation)
    );
  });
};

/**
 * An example: we print a long list of things without blocking the window's
 * event handling.
 */

var printThing = function (in_thing) {
  return atom(function () {
    console.debug(in_thing);
    return {};
  });
};

/**
 * Print a list of things, using concurrency! Other things can happen
 * in between prints.
 */
var printThings = function (in_things) {
  if (in_things.length === 0) {
    return stop();
  } else {
    var head = in_things[0];
    var tail = in_things.slice(1);
    // Must use andThen so that we don't force printThings here. We prefer
    // to evaluate that thunk on demand.
    return fork(printThing(head)).andThen(function () {
      return printThings(tail);
    });
  }
};

/**
 * Note that in our example we don't really need to fork: since each
 * printThing is an Atom, we'll yield between each individual print. The
 * forking in printThings would be useful if we wished to interleave other
 * actions, but is not needed for this demonstration.
 */
var printThingsSync = function (in_things) {
  if (in_things.length === 0) {
    return stop();
  } else {
    var head = in_things[0];
    var tail = in_things.slice(1);
    return printThing(head).andThen(function () {
      return printThings(tail);
    });
  }
};

var bigArray = [];
for (var i = 0; i < 1000; ++i) {
  bigArray.push(i);
}

window.addEventListener('mousemove', function (in_event) {
  console.debug('heard mousemove!');
});

/**
 * Run this with the JavaScript console open, then move the mosue over the
 * window. Note that the window's mousemove callbacks are not fired until
 * after this routine has exited.
 */
printTheArrayBlocking = function () {
  var printem = printThings(bigArray);
  RoundRobin.singleAction(action(printem)).runSync();
};

/**
 * Run this with the JavaScript console open, then move the mosue over the
 * window. Note that the window's mousemove callbacks are interleaved with
 * the prints.
 *
 * Also note how much longer it takes to run this compared to
 * printTheArrayBlocking().
 */
printTheArrayNonBlocking = function () {
  var printem = printThings(bigArray);
  RoundRobin.singleAction(action(printem)).runBatchAsync(5);
};
