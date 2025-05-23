package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"time"
)

var ttl = 0

func handler(w http.ResponseWriter, r *http.Request) {
	country := os.Getenv("CLOUDFLARE_COUNTRY_A2")
	location := os.Getenv("CLOUDFLARE_LOCATION")
	region := os.Getenv("CLOUDFLARE_REGION")
	text := fmt.Sprintf("Hi, I'm a container running in %s, %s, which is part of %s\n", location, country, region)
	text += "My env Vars are: \n"
	allVars := os.Environ()
	for _, env := range allVars {
		text += env + "\n"
	}
	text += "I was started with args:\n"
	for _, arg := range os.Args {
		text += arg + "\n"
	}

	text += fmt.Sprintf("I have %d cpus \n", runtime.NumCPU())
	text += fmt.Sprintf("I am shutting down in %d seconds\n", ttl)
	fmt.Fprintf(w, text)
}

func main() {
	http.HandleFunc("/", handler)
	http.HandleFunc("/_health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	go func() {
		for i := 0; i < 120; i++ {
			time.Sleep(time.Second)
			ttl = 120 - i
		}
		os.Exit(0)
	}()
	log.Fatal(http.ListenAndServe(":8080", nil))
}
